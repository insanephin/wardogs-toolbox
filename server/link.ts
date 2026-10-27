import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import type { Store, Link } from './store.ts';
import { HttpError, parseCookies } from './http.ts';
import type { Router } from './http.ts';
import type { Discord, VerifyResult } from './discord.ts';

const COOKIE = 'wd_link';
const SESSION_TTL_MS = 3600_000;
const STATE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_ENTRIES = 10_000;
const CHZZK_API = 'https://openapi.chzzk.naver.com';
const DISCORD_API = 'https://discord.com/api/v10';
const TWITCH_ID = 'https://id.twitch.tv/oauth2';
const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const STEAM_NS = 'http://specs.openid.net/auth/2.0';
const STEAM_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const STEAM_CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const JOIN_URL = 'https://wardogserverlist.com/join';

export const PROVIDERS = ['steam', 'chzzk', 'discord', 'twitch'] as const;
export type Provider = (typeof PROVIDERS)[number];
type PublicProvider = 'chzzk' | 'steam';
export type PanelResult = 'linked' | 'denied' | 'unlinked' | 'taken' | 'cancelled' | 'expired' | 'failed' | 'unconfigured';
type Result = 'linked' | 'proven' | 'taken' | 'cancelled' | 'expired' | 'failed' | 'unconfigured' | VerifyResult;

export interface Account {
  id: string;
  name: string;
  avatar?: string;
}

type Purpose = 'link' | 'admin' | 'identity' | 'report' | 'discord';

interface AdminLogin {
  allowed(req: IncomingMessage): boolean;
  sessionOf(req: IncomingMessage): string | undefined;
  login(provider: Provider, account: Account, previous: string | undefined): { result: PanelResult; cookie: string | null };
  identity(provider: Provider, account: Account, panelSid: string | undefined): PanelResult;
  proven(provider: PublicProvider, account: Account, previous: string | undefined): string | null;
}

interface Session {
  chzzk?: Account;
  steam?: Account;
  expires: number;
}

interface Pending {
  provider: Provider;
  purpose: Purpose;
  sid: string;
  panelSid?: string;
  ticket?: string;
  code?: string;
  expires: number;
}

class LinkError extends Error {
  result: Result;

  constructor(result: Result, detail?: string) {
    super(detail ?? result);
    this.result = result;
  }
}

async function json(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function makeRoom<K, V>(map: Map<K, V>): void {
  while (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value as K);
}

export const sqlNow = () => new Date().toISOString().slice(0, 23).replace('T', ' ');

export interface PublicServer {
  id: number;
  name: string;
  joinCode: string | null;
  public: boolean;
}

export const joinUrl = (code: string) => `${JOIN_URL}?${new URLSearchParams({ key: `id|${code}` })}`;

export function createLinking(config: Config, store: Store, admin: AdminLogin, servers: () => PublicServer[], discord: Discord) {
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Pending>();
  const configured: Record<Provider, boolean> = {
    chzzk: !!(config.chzzk.clientId && config.chzzk.clientSecret && config.chzzk.redirectUrl),
    steam: !!(config.steam.apiKey && config.steam.returnUrl),
    discord: !!(config.discord.clientId && config.discord.clientSecret && config.discord.redirectUrl),
    twitch: !!(config.twitch.clientId && config.twitch.clientSecret && config.twitch.redirectUrl),
  };

  const cookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;

  const sidOf = (req: IncomingMessage) => parseCookies(req.headers.cookie)[COOKIE];

  function session(req: IncomingMessage): Session | null {
    const sid = sidOf(req);
    const s = sid ? sessions.get(sid) : undefined;
    if (!s) return null;
    if (s.expires < Date.now()) {
      sessions.delete(sid!);
      return null;
    }
    return s;
  }

  function newState(provider: Provider, purpose: Purpose, sid: string, panelSid: string | undefined, ticket?: string, code?: string): string {
    const now = Date.now();
    for (const [k, p] of pending) {
      if (p.expires < now || (p.sid === sid && p.provider === provider)) pending.delete(k);
    }
    makeRoom(pending);
    const state = randomBytes(24).toString('base64url');
    pending.set(state, { provider, purpose, sid, panelSid, ticket, code, expires: now + STATE_TTL_MS });
    return state;
  }

  function takeState(state: string | null, provider: Provider, req: IncomingMessage): { s: Session; panelSid: string | undefined; ticket?: string } {
    const p = pending.get(state ?? '');
    if (state) pending.delete(state);
    const s = session(req);
    if (!p || !s || p.provider !== provider || p.expires < Date.now() || p.sid !== sidOf(req)) throw new LinkError('expired');
    return { s, panelSid: p.panelSid, ticket: p.ticket };
  }

  function redirect(res: ServerResponse, location: string, setCookie?: string | null) {
    res.writeHead(302, {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      ...(setCookie && { 'Set-Cookie': setCookie }),
    });
    res.end();
  }

  const back = (res: ServerResponse, provider: Provider, result: Result, purpose: Purpose = 'link', setCookie?: string | null, code?: string) => {
    const path = [code && encodeURIComponent(code), purpose === 'report' && 'report'].filter(Boolean).join('/');
    redirect(res, `/${path}?${new URLSearchParams({ r: result, p: provider })}`, setCookie);
  };
  const backAdmin = (res: ServerResponse, provider: Provider, result: PanelResult, setCookie?: string | null) =>
    redirect(res, result === 'linked' ? '/panel' : `/panel?${new URLSearchParams({ login: result, p: provider })}`, setCookie);
  const backIdentity = (res: ServerResponse, provider: Provider, result: PanelResult) =>
    redirect(res, `/panel?${new URLSearchParams({ identity: result, p: provider })}#account`);
  const backDiscord = (res: ServerResponse, result: Result, via: Provider) =>
    redirect(res, `/?${new URLSearchParams({ r: result, p: 'discord', via })}`);

  async function chzzkAccount(url: URL, state: string): Promise<Account> {
    const code = url.searchParams.get('code');
    if (!code) throw new LinkError('cancelled');
    const c = config.chzzk;
    const token = await json(`${CHZZK_API}/auth/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grantType: 'authorization_code', clientId: c.clientId, clientSecret: c.clientSecret, code, state }),
    });
    const access = token.body?.code === 200 ? token.body.content?.accessToken : null;
    if (!access) throw new LinkError('failed', `chzzk token ${JSON.stringify(token.body)}`);
    let me;
    try {
      me = await json(`${CHZZK_API}/open/v1/users/me`, { headers: { Authorization: `Bearer ${access}` } });
    } finally {
      fetch(`${CHZZK_API}/auth/v1/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: c.clientId, clientSecret: c.clientSecret, token: access, tokenTypeHint: 'access_token' }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => {});
    }
    const u = me.body?.code === 200 ? me.body.content : null;
    if (!u?.channelId) throw new LinkError('failed', `chzzk users/me ${JSON.stringify(me.body)}`);
    return { id: u.channelId, name: u.channelName };
  }

  async function oauthCode(url: URL, tokenUrl: string, c: { clientId: string; clientSecret: string; redirectUrl: string }): Promise<string> {
    if (url.searchParams.get('error') === 'access_denied') throw new LinkError('cancelled');
    const code = url.searchParams.get('code');
    if (!code) throw new LinkError('cancelled');
    const token = await json(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'authorization_code', code, redirect_uri: c.redirectUrl }),
    });
    const access = token.body?.access_token;
    if (!access) throw new LinkError('failed', `token ${token.status} ${JSON.stringify(token.body)}`);
    return access;
  }

  async function discordAccount(url: URL): Promise<Account> {
    const c = config.discord;
    const access = await oauthCode(url, `${DISCORD_API}/oauth2/token`, c);
    try {
      const me = await json(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${access}` } });
      if (!me.body?.id) throw new LinkError('failed', `discord users/@me ${JSON.stringify(me.body)}`);
      return { id: String(me.body.id), name: me.body.global_name || me.body.username };
    } finally {
      fetch(`${DISCORD_API}/oauth2/token/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, token: access }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => {});
    }
  }

  async function twitchAccount(url: URL): Promise<Account> {
    const c = config.twitch;
    const access = await oauthCode(url, `${TWITCH_ID}/token`, c);
    try {
      const me = await json('https://api.twitch.tv/helix/users', { headers: { Authorization: `Bearer ${access}`, 'Client-Id': c.clientId } });
      const u = me.body?.data?.[0];
      if (!u?.id) throw new LinkError('failed', `twitch users ${JSON.stringify(me.body)}`);
      return { id: String(u.id), name: u.display_name || u.login };
    } finally {
      fetch(`${TWITCH_ID}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: c.clientId, token: access }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => {});
    }
  }

  function steamAuthorizeUrl(state: string): string {
    const returnUrl = config.steam.returnUrl;
    return `${STEAM_OPENID}?${new URLSearchParams({
      'openid.ns': STEAM_NS,
      'openid.mode': 'checkid_setup',
      'openid.return_to': `${returnUrl}?${new URLSearchParams({ state })}`,
      'openid.realm': new URL(returnUrl).origin,
      'openid.identity': STEAM_SELECT,
      'openid.claimed_id': STEAM_SELECT,
    })}`;
  }

  async function steamAccount(url: URL): Promise<Account> {
    const q = url.searchParams;
    if (q.get('openid.mode') === 'cancel') throw new LinkError('cancelled');
    if (q.get('openid.mode') !== 'id_res' || q.get('openid.op_endpoint') !== STEAM_OPENID) throw new LinkError('failed', 'steam mode');
    if ((q.get('openid.return_to') ?? '').split('?')[0] !== config.steam.returnUrl) throw new LinkError('failed', 'steam return_to');
    const steamId = STEAM_CLAIMED_ID.exec(q.get('openid.claimed_id') ?? '')?.[1];
    if (!steamId) throw new LinkError('failed', 'steam claimed_id');

    const check = new URLSearchParams();
    for (const [k, v] of q) if (k.startsWith('openid.')) check.set(k, v);
    check.set('openid.mode', 'check_authentication');
    const verdict = await fetch(STEAM_OPENID, { method: 'POST', body: check, signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => r.text());
    if (!verdict.split('\n').includes('is_valid:true')) throw new LinkError('failed', `steam check ${verdict}`);

    const summary = await json(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?${new URLSearchParams({ key: config.steam.apiKey, steamids: steamId })}`)
      .catch(() => null);
    const p = summary?.body?.response?.players?.[0];
    return { id: steamId, name: p?.personaname ?? steamId, avatar: p?.avatarmedium || p?.avatar };
  }

  const accountOf = (provider: Provider, url: URL, state: string | null): Promise<Account> => {
    if (provider === 'chzzk') return chzzkAccount(url, state!);
    if (provider === 'discord') return discordAccount(url);
    if (provider === 'twitch') return twitchAccount(url);
    return steamAccount(url);
  };

  function authorizeUrl(provider: Provider, state: string): string {
    if (provider === 'steam') return steamAuthorizeUrl(state);
    if (provider === 'chzzk') {
      return `https://chzzk.naver.com/account-interlock?${new URLSearchParams({ clientId: config.chzzk.clientId, redirectUri: config.chzzk.redirectUrl, state })}`;
    }
    if (provider === 'discord') {
      return `https://discord.com/oauth2/authorize?${new URLSearchParams({
        client_id: config.discord.clientId, redirect_uri: config.discord.redirectUrl, response_type: 'code', scope: 'identify', state,
      })}`;
    }
    return `${TWITCH_ID}/authorize?${new URLSearchParams({
      client_id: config.twitch.clientId, redirect_uri: config.twitch.redirectUrl, response_type: 'code', scope: '', state,
    })}`;
  }

  function start(provider: Provider, purpose: Purpose, req: IncomingMessage, res: ServerResponse, ticket?: string, code?: string) {
    let sid = sidOf(req);
    let setCookie: string | undefined;
    if (!sid || !session(req)) {
      const now = Date.now();
      for (const [k, s] of sessions) if (s.expires < now) sessions.delete(k);
      makeRoom(sessions);
      sid = randomBytes(32).toString('base64url');
      sessions.set(sid, { expires: Date.now() + SESSION_TTL_MS });
      setCookie = cookie(sid, SESSION_TTL_MS / 1000);
    }
    const state = newState(provider, purpose, sid, admin.sessionOf(req), ticket, code);
    redirect(res, authorizeUrl(provider, state), setCookie);
  }

  async function adminCallback(provider: Provider, url: URL, state: string | null, req: IncomingMessage, res: ServerResponse) {
    try {
      const { panelSid } = takeState(state, provider, req);
      const account = await accountOf(provider, url, state);
      if (!admin.allowed(req)) return backAdmin(res, provider, 'denied');
      const r = admin.login(provider, account, panelSid);
      if (r.result !== 'linked') console.warn(`[관리자] 로그인 거부(${r.result}): ${provider} ${account.name} (${account.id})`);
      else console.log(`[관리자] 로그인: ${provider} ${account.name} (${account.id})`);
      backAdmin(res, provider, r.result, r.cookie);
    } catch (err) {
      const result = err instanceof LinkError ? err.result as PanelResult : 'failed';
      if (result === 'failed') console.error(`[관리자] ${provider} 로그인 실패:`, err instanceof Error ? err.message : err);
      backAdmin(res, provider, result);
    }
  }

  async function identityCallback(provider: Provider, url: URL, state: string | null, req: IncomingMessage, res: ServerResponse) {
    try {
      const { panelSid } = takeState(state, provider, req);
      const account = await accountOf(provider, url, state);
      backIdentity(res, provider, admin.identity(provider, account, panelSid));
    } catch (err) {
      const result = err instanceof LinkError ? err.result as PanelResult : 'failed';
      if (result === 'failed') console.error(`[관리자] ${provider} 연결 실패:`, err instanceof Error ? err.message : err);
      backIdentity(res, provider, result);
    }
  }

  async function discordCallback(provider: PublicProvider, url: URL, state: string | null, req: IncomingMessage, res: ServerResponse) {
    try {
      const { ticket } = takeState(state, provider, req);
      const account = provider === 'chzzk' ? await chzzkAccount(url, state!) : await steamAccount(url);
      backDiscord(res, await discord.step(ticket!, provider, account), provider);
    } catch (err) {
      const result = err instanceof LinkError ? err.result : 'failed';
      if (result === 'failed') console.error(`[디스코드] ${provider} 인증 실패:`, err instanceof Error ? err.message : err);
      backDiscord(res, result, provider);
    }
  }

  const notGet = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET') return false;
    res.writeHead(405).end();
    return true;
  };

  async function handle(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const dv = /^\/discord\/verify\/(chzzk|steam)$/.exec(url.pathname);
    if (dv) {
      if (notGet(req, res)) return true;
      const provider = dv[1] as PublicProvider;
      const ticket = url.searchParams.get('t') ?? '';
      if (!discord.configured || !configured[provider]) backDiscord(res, 'unconfigured', provider);
      else if (!discord.valid(ticket)) backDiscord(res, 'expired', provider);
      else start(provider, 'discord', req, res, ticket);
      return true;
    }

    const panel = /^\/panel\/(login|link)(?:\/(steam|chzzk|discord|twitch))?$/.exec(url.pathname);
    if (panel) {
      if (!admin.allowed(req)) return false;
      if (notGet(req, res)) return true;
      const provider = (panel[2] ?? 'steam') as Provider;
      if (panel[1] === 'login') {
        if (provider !== 'steam') backAdmin(res, provider, 'failed');
        else if (!configured[provider]) backAdmin(res, provider, 'unconfigured');
        else start(provider, 'admin', req, res);
      } else if (provider === 'steam') {
        backIdentity(res, provider, 'failed');
      } else if (!configured[provider]) {
        backIdentity(res, provider, 'unconfigured');
      } else if (!admin.sessionOf(req)) {
        backAdmin(res, provider, 'expired');
      } else {
        start(provider, 'identity', req, res);
      }
      return true;
    }

    const m = /^\/(auth|callback)\/(chzzk|steam|discord|twitch)$/.exec(url.pathname);
    if (!m) return false;
    const step = m[1];
    const provider = m[2] as Provider;
    if (notGet(req, res)) return true;
    const state = url.searchParams.get('state');
    const purpose: Purpose = step === 'auth'
      ? (url.searchParams.get('next') === 'report' ? 'report' : 'link')
      : (state && pending.get(state)?.purpose) || 'link';
    const asked = url.searchParams.get('s');
    const code = step === 'auth' ? (asked && servers().some((x) => x.joinCode === asked) ? asked : undefined) : (state && pending.get(state)?.code) || undefined;
    if (purpose === 'admin') return adminCallback(provider, url, state, req, res), true;
    if (purpose === 'identity') return identityCallback(provider, url, state, req, res), true;
    if (provider !== 'chzzk' && provider !== 'steam') return back(res, provider, 'expired', purpose, null, code), true;
    try {
      if (!configured[provider]) throw new LinkError('unconfigured');

      if (step === 'auth') {
        start(provider, purpose, req, res, undefined, code);
        return true;
      }
      if (purpose === 'discord') {
        await discordCallback(provider, url, state, req, res);
        return true;
      }
      const { s, panelSid } = takeState(state, provider, req);
      s[provider] = provider === 'chzzk' ? await chzzkAccount(url, state!) : await steamAccount(url);
      const clear = admin.proven(provider, s[provider]!, panelSid);
      if (s.chzzk && s.steam) {
        if (!store.linkIfFree(s.steam, s.chzzk, sqlNow())) {
          delete s[provider];
          return back(res, provider, 'taken', purpose, clear, code), true;
        }
        back(res, provider, 'linked', purpose, clear, code);
      } else back(res, provider, 'proven', purpose, clear, code);
    } catch (err) {
      const result = err instanceof LinkError ? err.result : 'failed';
      if (result === 'failed') console.error(`[연동] ${provider} 실패:`, err instanceof Error ? err.message : err);
      if (purpose === 'discord') backDiscord(res, result, provider);
      else back(res, provider, result, purpose, null, code);
    }
    return true;
  }

  const linkOf = (s: Session): Link | null =>
    (s.steam && store.linkByAccount('steam', s.steam.id)) || (s.chzzk && store.linkByAccount('chzzk', s.chzzk.id)) || null;

  const joins = (link: Link | null, only: PublicServer | null) => (link ? (only ? [only] : servers().filter((s) => s.public))
    .filter((s) => s.joinCode)
    .map((s) => ({ id: s.id, name: s.name, url: joinUrl(s.joinCode!) })) : []);

  const view = (s: Session | null, only: PublicServer | null) => {
    if (!s) return { chzzk: null, steam: null, link: null, joins: [] };
    const link = linkOf(s);
    return { chzzk: s.chzzk?.name ?? null, steam: s.steam?.name ?? null, link, joins: joins(link, only) };
  };

  function register(router: Router) {
    router.add('GET', '/api/link/me', { public: true }, ({ req, query }) => {
      const code = query.get('server');
      const only = code ? servers().find((x) => x.joinCode === code) ?? null : null;
      if (code && !only) throw new HttpError(404, 'no_server', '없는 서버 주소입니다');
      return {
        configured: { chzzk: configured.chzzk, steam: configured.steam },
        server: only && { name: only.name, joinCode: only.joinCode },
        ...view(session(req), only),
      };
    });
  }

  const accounts = (req: IncomingMessage): { chzzk?: Account; steam?: Account } | null => {
    const s = session(req);
    return s && (s.chzzk || s.steam) ? { chzzk: s.chzzk, steam: s.steam } : null;
  };

  return { handle, register, accounts, configured };
}

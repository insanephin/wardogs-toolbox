import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import type { Store, Link } from './store.ts';
import { parseCookies } from './http.ts';
import type { Router } from './http.ts';
import type { Discord, VerifyResult } from './discord.ts';

const COOKIE = 'wd_link';
const SESSION_TTL_MS = 3600_000;
const STATE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_ENTRIES = 10_000;
const CHZZK_API = 'https://openapi.chzzk.naver.com';
const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const STEAM_NS = 'http://specs.openid.net/auth/2.0';
const STEAM_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const STEAM_CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const JOIN_URL = 'https://wardogserverlist.com/join';

export type Provider = 'chzzk' | 'steam';
type Result = 'linked' | 'proven' | 'taken' | 'cancelled' | 'expired' | 'failed' | 'unconfigured' | VerifyResult;

export interface Account {
  id: string;
  name: string;
}

type Purpose = 'link' | 'admin' | 'report' | 'discord';

interface AdminLogin {
  allowed(req: IncomingMessage): boolean;
  sessionOf(req: IncomingMessage): string | undefined;
  login(account: Account, previous: string | undefined): { ok: boolean; cookie: string | null };
  proven(account: Account, previous: string | undefined): string | null;
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

export function createLinking(config: Config, store: Store, admin: AdminLogin, serverId: () => string | null, discord: Discord) {
  const sessions = new Map<string, Session>();
  const pending = new Map<string, Pending>();
  const configured = {
    chzzk: !!(config.chzzk.clientId && config.chzzk.clientSecret && config.chzzk.redirectUrl),
    steam: !!(config.steam.apiKey && config.steam.returnUrl),
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

  function newState(provider: Provider, purpose: Purpose, sid: string, panelSid: string | undefined, ticket?: string): string {
    const now = Date.now();
    for (const [k, p] of pending) {
      if (p.expires < now || (p.sid === sid && p.provider === provider)) pending.delete(k);
    }
    makeRoom(pending);
    const state = randomBytes(24).toString('base64url');
    pending.set(state, { provider, purpose, sid, panelSid, ticket, expires: now + STATE_TTL_MS });
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

  const back = (res: ServerResponse, provider: Provider, result: Result, purpose: Purpose = 'link', setCookie?: string | null) =>
    redirect(res, `/${purpose === 'report' ? 'report' : ''}?${new URLSearchParams({ r: result, p: provider })}`, setCookie);
  const backAdmin = (res: ServerResponse, result: Result | 'denied', setCookie?: string | null) =>
    redirect(res, result === 'linked' ? '/rcon' : `/rcon?${new URLSearchParams({ login: result })}`, setCookie);
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
    return { id: steamId, name: summary?.body?.response?.players?.[0]?.personaname ?? steamId };
  }

  function start(provider: Provider, purpose: Purpose, req: IncomingMessage, res: ServerResponse, ticket?: string) {
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
    const state = newState(provider, purpose, sid, admin.sessionOf(req), ticket);
    redirect(res, provider === 'chzzk'
      ? `https://chzzk.naver.com/account-interlock?${new URLSearchParams({ clientId: config.chzzk.clientId, redirectUri: config.chzzk.redirectUrl, state })}`
      : steamAuthorizeUrl(state), setCookie);
  }

  async function adminCallback(url: URL, state: string, req: IncomingMessage, res: ServerResponse) {
    try {
      const { panelSid } = takeState(state, 'chzzk', req);
      const account = await chzzkAccount(url, state);
      if (!admin.allowed(req)) return backAdmin(res, 'denied');
      const r = admin.login(account, panelSid);
      if (!r.ok) {
        console.warn(`[관리자] 허용되지 않은 치지직 채널의 로그인 시도: ${account.name} (${account.id})`);
        return backAdmin(res, 'denied', r.cookie);
      }
      console.log(`[관리자] 로그인: ${account.name} (${account.id})`);
      backAdmin(res, 'linked', r.cookie);
    } catch (err) {
      const result = err instanceof LinkError ? err.result : 'failed';
      if (result === 'failed') console.error('[관리자] 치지직 로그인 실패:', err instanceof Error ? err.message : err);
      backAdmin(res, result);
    }
  }

  async function discordCallback(provider: Provider, url: URL, state: string | null, req: IncomingMessage, res: ServerResponse) {
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

  async function handle(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const dv = /^\/discord\/verify\/(chzzk|steam)$/.exec(url.pathname);
    if (dv) {
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return true;
      }
      const provider = dv[1] as Provider;
      const ticket = url.searchParams.get('t') ?? '';
      if (!discord.configured || !configured[provider]) backDiscord(res, 'unconfigured', provider);
      else if (!discord.valid(ticket)) backDiscord(res, 'expired', provider);
      else start(provider, 'discord', req, res, ticket);
      return true;
    }
    if (url.pathname === '/rcon/login') {
      if (!admin.allowed(req)) return false;
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return true;
      }
      if (!configured.chzzk) backAdmin(res, 'unconfigured');
      else start('chzzk', 'admin', req, res);
      return true;
    }
    const m = /^\/(auth|callback)\/(chzzk|steam)$/.exec(url.pathname);
    if (!m) return false;
    const step = m[1];
    const provider = m[2] as Provider;
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return true;
    }
    const state = url.searchParams.get('state');
    const purpose: Purpose = step === 'auth'
      ? (url.searchParams.get('next') === 'report' ? 'report' : 'link')
      : (state && pending.get(state)?.purpose) || 'link';
    try {
      if (!configured[provider]) throw new LinkError('unconfigured');

      if (step === 'auth') {
        start(provider, purpose, req, res);
        return true;
      }

      if (provider === 'chzzk' && state && purpose === 'admin') {
        await adminCallback(url, state, req, res);
        return true;
      }
      if (purpose === 'discord') {
        await discordCallback(provider, url, state, req, res);
        return true;
      }
      const { s, panelSid } = takeState(state, provider, req);
      s[provider] = provider === 'chzzk' ? await chzzkAccount(url, state!) : await steamAccount(url);
      const clear = provider === 'chzzk' ? admin.proven(s.chzzk!, panelSid) : null;
      if (s.chzzk && s.steam) {
        if (!store.linkIfFree(s.steam, s.chzzk, sqlNow())) {
          delete s[provider];
          return back(res, provider, 'taken', purpose, clear), true;
        }
        back(res, provider, 'linked', purpose, clear);
      } else back(res, provider, 'proven', purpose, clear);
    } catch (err) {
      const result = err instanceof LinkError ? err.result : 'failed';
      if (result === 'failed') console.error(`[연동] ${provider} 실패:`, err instanceof Error ? err.message : err);
      if (purpose === 'discord') backDiscord(res, result, provider);
      else back(res, provider, result, purpose);
    }
    return true;
  }

  const linkOf = (s: Session): Link | null =>
    (s.steam && store.linkByAccount('steam', s.steam.id)) || (s.chzzk && store.linkByAccount('chzzk', s.chzzk.id)) || null;

  const joinUrl = (link: Link | null) => {
    const id = link && serverId();
    return id ? `${JOIN_URL}?${new URLSearchParams({ key: `id|${id}` })}` : null;
  };

  const view = (s: Session | null) => {
    if (!s) return { chzzk: null, steam: null, link: null, joinUrl: null };
    const link = linkOf(s);
    return { chzzk: s.chzzk?.name ?? null, steam: s.steam?.name ?? null, link, joinUrl: joinUrl(link) };
  };

  function register(router: Router) {
    router.add('GET', '/api/link/me', { public: true }, ({ req }) => ({ configured, ...view(session(req)) }));
  }

  const accounts = (req: IncomingMessage): { chzzk?: Account; steam?: Account } | null => {
    const s = session(req);
    return s && (s.chzzk || s.steam) ? { chzzk: s.chzzk, steam: s.steam } : null;
  };

  return { handle, register, accounts, configured };
}

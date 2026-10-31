import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from './config.ts';
import type { Store, Link, DiscordGuild } from './store.ts';
import { HttpError, parseCookies } from './http.ts';
import type { Router } from './http.ts';
import { DISCORD_BOT_PERMISSIONS, botInstallConfigured } from './discord.ts';
import type { Discord, VerifyResult } from './discord.ts';
import type { Kv } from './kv.ts';
import { chzzkToken, chzzkMe, chzzkRevoke } from './chzzk.ts';
import type { ChzzkToken } from './chzzk.ts';

const COOKIE = 'wd_link';
const SESSION_TTL_MS = 3600_000;
const STATE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;
const DISCORD_API = 'https://discord.com/api/v10';
const TWITCH_ID = 'https://id.twitch.tv/oauth2';
const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const STEAM_NS = 'http://specs.openid.net/auth/2.0';
const STEAM_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const STEAM_SIGNED = ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle'];
const STEAM_CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const JOIN_URL = 'https://wardogserverlist.com/join';

const PROVIDERS = ['steam', 'chzzk', 'discord', 'twitch'] as const;
export type Provider = (typeof PROVIDERS)[number];
type PublicProvider = 'chzzk' | 'steam';
export type PanelResult = 'linked' | 'denied' | 'unlinked' | 'taken' | 'cancelled' | 'expired' | 'failed' | 'unconfigured';
type Result = 'linked' | 'proven' | 'taken' | 'cancelled' | 'expired' | 'failed' | 'unconfigured' | VerifyResult;

export interface Account {
  id: string;
  name: string;
  avatar?: string;
}

type Purpose = 'link' | 'admin' | 'identity' | 'report' | 'discord' | 'owner' | 'bot';

interface AdminLogin {
  sessionOf(req: IncomingMessage): string | undefined;
  login(provider: Provider, account: Account, previous: string | undefined): { result: PanelResult; cookie: string | null };
  identity(provider: Provider, account: Account, panelSid: string | undefined): PanelResult;
  proven(provider: PublicProvider, account: Account, previous: string | undefined): string | null;
  canManage(panelSid: string | undefined, serverId: number): boolean;
  chzzkOwner(panelSid: string | undefined, serverId: number, token: ChzzkToken, channel: Account): Promise<PanelResult>;
  discordGuild(panelSid: string | undefined, serverId: number, guild: DiscordGuild): PanelResult;
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
  serverId?: number;
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

const sessionKey = (sid: string) => `link:session:${sid}`;
const stateKey = (state: string) => `link:state:${state}`;

export const sqlNow = () => new Date().toISOString().slice(0, 23).replace('T', ' ');

export interface PublicServer {
  id: number;
  name: string;
  joinCode: string | null;
  public: boolean;
  demo: boolean;
  status(): { online: boolean; players: number; maxPlayers: number | null; map: string | null };
  entry(): { rule: EntryRule; channel: string | null };
  passes(link: Link): boolean;
}

type EntryRule = 'open' | 'linked' | 'follower' | 'subscriber';

export const joinUrl = (code: string) => `${JOIN_URL}?${new URLSearchParams({ key: `id|${code}` })}`;

export function createLinking(config: Config, store: Store, kv: Kv, admin: AdminLogin, servers: () => PublicServer[], discord: Discord) {
  const configured: Record<Provider, boolean> = {
    chzzk: !!(config.chzzk.clientId && config.chzzk.clientSecret && config.chzzk.redirectUrl),
    steam: !!(config.steam.apiKey && config.steam.returnUrl),
    discord: !!(config.discord.clientId && config.discord.clientSecret && config.discord.redirectUrl),
    twitch: !!(config.twitch.clientId && config.twitch.clientSecret && config.twitch.redirectUrl),
  };
  const botConfigured = botInstallConfigured(config);

  const cookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;

  const sidOf = (req: IncomingMessage) => parseCookies(req.headers.cookie)[COOKIE];

  async function session(req: IncomingMessage): Promise<Session | null> {
    const sid = sidOf(req);
    const s = sid ? await kv.get<Session>(sessionKey(sid)) : null;
    return s && s.expires > Date.now() ? s : null;
  }

  const saveSession = (sid: string, s: Session) => kv.set(sessionKey(sid), s, s.expires - Date.now());

  async function newState(provider: Provider, purpose: Purpose, sid: string, panelSid: string | undefined, ticket?: string, code?: string, serverId?: number): Promise<string> {
    const state = randomBytes(24).toString('base64url');
    await kv.set(stateKey(state), { provider, purpose, sid, panelSid, ticket, code, serverId, expires: Date.now() + STATE_TTL_MS } satisfies Pending, STATE_TTL_MS);
    return state;
  }

  const peekState = (state: string | null) => (state ? kv.get<Pending>(stateKey(state)) : Promise.resolve(null));

  async function takeState(state: string | null, provider: Provider, req: IncomingMessage): Promise<{ sid: string; s: Session; panelSid: string | undefined; ticket?: string; serverId?: number }> {
    const p = state ? await kv.take<Pending>(stateKey(state)) : null;
    const sid = sidOf(req);
    const s = await session(req);
    if (!p || !s || !sid || p.provider !== provider || p.expires < Date.now() || p.sid !== sid) throw new LinkError('expired');
    return { sid, s, panelSid: p.panelSid, ticket: p.ticket, serverId: p.serverId };
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
  const backOwner = (res: ServerResponse, result: PanelResult) =>
    redirect(res, `/panel?${new URLSearchParams({ owner: result })}#links`);
  const backBot = (res: ServerResponse, result: PanelResult) =>
    redirect(res, `/panel?${new URLSearchParams({ discord: result })}#server`);
  const backDiscord = (res: ServerResponse, result: Result, via: Provider) =>
    redirect(res, `/?${new URLSearchParams({ r: result, p: 'discord', via })}`);

  async function chzzkLogin(url: URL, state: string): Promise<{ token: ChzzkToken; account: Account }> {
    const code = url.searchParams.get('code');
    if (!code) throw new LinkError('cancelled');
    const token = await chzzkToken(config, code, state).catch((err) => {
      throw new LinkError('failed', err instanceof Error ? err.message : String(err));
    });
    try {
      return { token, account: await chzzkMe(token.accessToken) };
    } catch (err) {
      chzzkRevoke(config, token.accessToken, 'access_token');
      throw new LinkError('failed', err instanceof Error ? err.message : String(err));
    }
  }

  async function chzzkAccount(url: URL, state: string): Promise<Account> {
    const { token, account } = await chzzkLogin(url, state);
    chzzkRevoke(config, token.accessToken, 'access_token');
    return account;
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
    if (q.get('openid.identity') !== q.get('openid.claimed_id')) throw new LinkError('failed', 'steam identity');
    const signed = new Set((q.get('openid.signed') ?? '').split(','));
    if (!STEAM_SIGNED.every((f) => signed.has(f))) throw new LinkError('failed', 'steam signed fields');

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

  function authorizeUrl(provider: Provider, purpose: Purpose, state: string): string {
    if (purpose === 'bot') {
      return `https://discord.com/oauth2/authorize?${new URLSearchParams({
        client_id: config.discord.botClientId, redirect_uri: config.discord.botRedirectUrl, response_type: 'code',
        scope: 'bot applications.commands', permissions: DISCORD_BOT_PERMISSIONS, integration_type: '0', state,
      })}`;
    }
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

  async function start(provider: Provider, purpose: Purpose, req: IncomingMessage, res: ServerResponse, ticket?: string, code?: string, serverId?: number) {
    let sid = sidOf(req);
    let setCookie: string | undefined;
    if (!sid || !(await session(req))) {
      sid = randomBytes(32).toString('base64url');
      await saveSession(sid, { expires: Date.now() + SESSION_TTL_MS });
      setCookie = cookie(sid, SESSION_TTL_MS / 1000);
    }
    const state = await newState(provider, purpose, sid, admin.sessionOf(req), ticket, code, serverId);
    redirect(res, authorizeUrl(provider, purpose, state), setCookie);
  }

  async function adminCallback(provider: Provider, url: URL, state: string | null, req: IncomingMessage, res: ServerResponse) {
    try {
      const { panelSid } = await takeState(state, provider, req);
      const account = await accountOf(provider, url, state);
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
      const { panelSid } = await takeState(state, provider, req);
      const account = await accountOf(provider, url, state);
      backIdentity(res, provider, admin.identity(provider, account, panelSid));
    } catch (err) {
      const result = err instanceof LinkError ? err.result as PanelResult : 'failed';
      if (result === 'failed') console.error(`[관리자] ${provider} 연결 실패:`, err instanceof Error ? err.message : err);
      backIdentity(res, provider, result);
    }
  }

  async function ownerCallback(url: URL, state: string | null, req: IncomingMessage, res: ServerResponse) {
    try {
      const { panelSid, serverId } = await takeState(state, 'chzzk', req);
      const { token, account } = await chzzkLogin(url, state!);
      const result = await admin.chzzkOwner(panelSid, serverId!, token, account);
      if (result !== 'linked') chzzkRevoke(config, token.refreshToken, 'refresh_token');
      backOwner(res, result);
    } catch (err) {
      const result = err instanceof LinkError ? err.result as PanelResult : 'failed';
      if (result === 'failed') console.error('[치지직] 스트리머 연결 실패:', err instanceof Error ? err.message : err);
      backOwner(res, result);
    }
  }

  async function botCallback(url: URL, state: string | null, req: IncomingMessage, res: ServerResponse) {
    try {
      const { panelSid, serverId } = await takeState(state, 'discord', req);
      const c = config.discord;
      if (url.searchParams.get('error') === 'access_denied') throw new LinkError('cancelled');
      const code = url.searchParams.get('code');
      if (!code) throw new LinkError('cancelled');
      const token = await json(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: c.botClientId, client_secret: c.botClientSecret, grant_type: 'authorization_code', code, redirect_uri: c.botRedirectUrl }),
      });
      const access = token.body?.access_token;
      if (access) {
        fetch(`${DISCORD_API}/oauth2/token/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: c.botClientId, client_secret: c.botClientSecret, token: access }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }).catch(() => {});
      }
      const guild = token.body?.guild;
      if (!guild?.id) throw new LinkError('failed', `discord bot token ${token.status} ${JSON.stringify(token.body)}`);
      backBot(res, admin.discordGuild(panelSid, serverId!, { id: String(guild.id), name: String(guild.name ?? guild.id) }));
    } catch (err) {
      const result = err instanceof LinkError ? err.result as PanelResult : 'failed';
      if (result === 'failed') console.error('[디스코드] 봇 추가 실패:', err instanceof Error ? err.message : err);
      backBot(res, result);
    }
  }

  async function discordCallback(provider: PublicProvider, url: URL, state: string | null, req: IncomingMessage, res: ServerResponse) {
    try {
      const { ticket } = await takeState(state, provider, req);
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
      else if (!(await discord.valid(ticket))) backDiscord(res, 'expired', provider);
      else await start(provider, 'discord', req, res, ticket);
      return true;
    }

    const owner = /^\/panel\/chzzk-owner\/(\d+)$/.exec(url.pathname);
    if (owner) {
      if (notGet(req, res)) return true;
      const serverId = Number(owner[1]);
      if (!configured.chzzk) backOwner(res, 'unconfigured');
      else if (!admin.sessionOf(req)) backAdmin(res, 'chzzk', 'expired');
      else if (!admin.canManage(admin.sessionOf(req), serverId)) backOwner(res, 'denied');
      else await start('chzzk', 'owner', req, res, undefined, undefined, serverId);
      return true;
    }

    const addBot = /^\/panel\/discord-bot\/(\d+)$/.exec(url.pathname);
    if (addBot) {
      if (notGet(req, res)) return true;
      const serverId = Number(addBot[1]);
      if (!botConfigured) backBot(res, 'unconfigured');
      else if (!admin.sessionOf(req)) backAdmin(res, 'discord', 'expired');
      else if (!admin.canManage(admin.sessionOf(req), serverId)) backBot(res, 'denied');
      else await start('discord', 'bot', req, res, undefined, undefined, serverId);
      return true;
    }

    if (url.pathname === '/callback/discord-bot') {
      if (notGet(req, res)) return true;
      await botCallback(url, url.searchParams.get('state'), req, res);
      return true;
    }

    const panel = /^\/panel\/(login|link)(?:\/(steam|chzzk|discord|twitch))?$/.exec(url.pathname);
    if (panel) {
      if (notGet(req, res)) return true;
      const provider = (panel[2] ?? 'steam') as Provider;
      if (panel[1] === 'login') {
        if (provider !== 'steam') backAdmin(res, provider, 'failed');
        else if (!configured[provider]) backAdmin(res, provider, 'unconfigured');
        else await start(provider, 'admin', req, res);
      } else if (provider === 'steam') {
        backIdentity(res, provider, 'failed');
      } else if (!configured[provider]) {
        backIdentity(res, provider, 'unconfigured');
      } else if (!admin.sessionOf(req)) {
        backAdmin(res, provider, 'expired');
      } else {
        await start(provider, 'identity', req, res);
      }
      return true;
    }

    const m = /^\/(auth|callback)\/(chzzk|steam|discord|twitch)$/.exec(url.pathname);
    if (!m) return false;
    const step = m[1];
    const provider = m[2] as Provider;
    if (notGet(req, res)) return true;
    const state = url.searchParams.get('state');
    const peeked = step === 'callback' ? await peekState(state) : null;
    const purpose: Purpose = step === 'auth'
      ? (url.searchParams.get('next') === 'report' ? 'report' : 'link')
      : peeked?.purpose || 'link';
    const asked = url.searchParams.get('s');
    const code = step === 'auth' ? (asked && servers().some((x) => x.joinCode === asked) ? asked : undefined) : peeked?.code || undefined;
    if (purpose === 'admin') return adminCallback(provider, url, state, req, res), true;
    if (purpose === 'identity') return identityCallback(provider, url, state, req, res), true;
    if (purpose === 'owner') return ownerCallback(url, state, req, res), true;
    if (purpose === 'bot') return backBot(res, 'expired'), true;
    if (provider !== 'chzzk' && provider !== 'steam') return back(res, provider, 'expired', purpose, null, code), true;
    try {
      if (!configured[provider]) throw new LinkError('unconfigured');

      if (step === 'auth') {
        await start(provider, purpose, req, res, undefined, code);
        return true;
      }
      if (purpose === 'discord') {
        await discordCallback(provider, url, state, req, res);
        return true;
      }
      const { sid, s, panelSid } = await takeState(state, provider, req);
      s[provider] = provider === 'chzzk' ? await chzzkAccount(url, state!) : await steamAccount(url);
      const clear = admin.proven(provider, s[provider]!, panelSid);
      let result: Result = 'proven';
      if (s.chzzk && s.steam) {
        if (store.linkIfFree(s.steam, s.chzzk, sqlNow())) result = 'linked';
        else {
          delete s[provider];
          result = 'taken';
        }
      }
      await saveSession(sid, s);
      back(res, provider, result, purpose, clear, code);
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

  const joins = (link: Link | null, only: PublicServer | null) => (only ? [only] : link ? servers().filter((s) => s.public) : [])
    .filter((s) => s.joinCode && !s.demo && (s.entry().rule === 'open' || (link && s.passes(link))))
    .map((s) => ({ id: s.id, name: s.name, url: joinUrl(s.joinCode!) }));

  const access = (link: Link | null, only: PublicServer | null) => {
    if (!only) return null;
    const { rule } = only.entry();
    if (rule === 'open') return 'ok';
    if (!link) return 'link';
    return only.passes(link) ? 'ok' : rule === 'follower' ? 'follow' : 'subscribe';
  };

  const serverView = (only: PublicServer | null) => only && { name: only.name, joinCode: only.joinCode, ...only.status(), ...only.entry() };

  const view = (s: Session | null, only: PublicServer | null) => {
    const link = s && linkOf(s);
    return { chzzk: s?.chzzk?.name ?? null, steam: s?.steam?.name ?? null, link, joins: joins(link, only), access: access(link, only) };
  };

  function register(router: Router) {
    router.add('GET', '/api/link/me', { public: true }, async ({ req, query }) => {
      const code = query.get('server');
      const only = code ? servers().find((x) => x.joinCode === code) ?? null : null;
      if (code && !only) throw new HttpError(404, 'no_server', '없는 서버 주소입니다');
      return {
        configured: { chzzk: configured.chzzk, steam: configured.steam },
        server: serverView(only),
        ...view(await session(req), only),
      };
    });
  }

  const accounts = async (req: IncomingMessage): Promise<{ chzzk?: Account; steam?: Account } | null> => {
    const s = await session(req);
    return s && (s.chzzk || s.steam) ? { chzzk: s.chzzk, steam: s.steam } : null;
  };

  return { handle, register, accounts, configured, botConfigured };
}

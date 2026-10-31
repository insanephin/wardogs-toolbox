import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { Auth, hasRole } from './auth.ts';
import type { Session } from './auth.ts';
import { Router, HttpError, SseHub, sendJson, readJson, parseCookies, serveStatic, SECURITY_HEADERS } from './http.ts';
import { RconError } from './rcon.ts';
import { Store } from './store.ts';
import type { Role } from './store.ts';
import { WeaponNames } from './weapons.ts';
import { registerApi } from './api.ts';
import { createLinking } from './link.ts';
import type { Account, PanelResult, Provider } from './link.ts';
import { registerReports } from './report.ts';
import { createDiscord } from './discord.ts';
import { createSteamProfiles } from './steam.ts';
import { createMapArt } from './mapart.ts';
import { createFleet } from './fleet.ts';
import type { ServerRuntime } from './fleet.ts';
import { registerServers, roleOf } from './servers.ts';
import { createDemo, GUEST_STEAM_ID, GUEST_NAME } from './demo.ts';
import { createChzzkSubscribers } from './chzzk.ts';
import { connectKv } from './kv.ts';
import type { Kv } from './kv.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'wd_session';
const CSRF_HEADER = 'x-requested-with';
const PUBLIC_DIST = join(ROOT, 'dist/public');
const ADMIN_DIST = join(ROOT, 'dist/admin');
const PUBLIC_PAGES = new Set(['/', '/report']);
const RESERVED = new Set(['panel', 'rcon', 'report', 'assets', 'api', 'auth', 'callback', 'discord', 'terms', 'privacy']);
const POLICY_URL = 'https://insanephin.xyz/projects/wardogs-rcon';
const POLICY_PAGES = new Set(['/terms', '/privacy']);
const GUEST_GLOBAL = /^\/api\/(me|servers|account|map-art)$/;
const GUEST_BLOCKED = /^\/api\/s\/\d+\/(server|owner|chzzk-owner(\/sync)?|members\/[^/]+|rcon|feed-token(\/rotate)?|discord-guild|links\/[^/]+)$/;

function notFound(url: URL, res: ServerResponse) {
  if (/^\/(rcon\/)?assets\//.test(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    return res.end('페이지를 찾을 수 없습니다');
  }
  res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
  res.end();
}

function createApp(config: Config, kv: Kv) {
  const store = new Store(config.dbPath, { legacyFeedToken: config.feedToken, legacyDiscordServerId: config.discord.legacyServerId, secretKey: config.dbSecretKey });
  const auth = new Auth(config.superadmins, store);
  const hub = new SseHub();
  const steam = createSteamProfiles(config.steam.apiKey);
  const weapons = new WeaponNames(join(ROOT, 'data/weapons.json'));
  weapons.watch((renames) => store.renameWeapons(renames));
  const demo = createDemo(store, weapons.readOnly());
  const fleet = createFleet({
    store, hub, steam, weapons,
    gapSec: config.engagementGapSec,
    minKills: config.engagementMinKills,
    demoRcon: demo.rcon,
  });
  fleet.load();

  const router = new Router();
  const discord = createDiscord({ config, store, fleet, kv });
  const subscribers = createChzzkSubscribers(config, fleet);
  registerApi(router, { fleet, store, config, discord, steam, subscribers });
  discord.register(router);
  const cookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;

  const endPanelSession = (sid: string | undefined) => {
    auth.logout(sid);
    hub.closeSession(sid);
  };

  const panelLogin = (provider: Provider, account: Account, previous: string | undefined): { result: PanelResult; cookie: string | null } => {
    if (provider !== 'steam') return { result: 'failed', cookie: previous ? cookie('', 0) : null };
    const steamId = account.id;
    endPanelSession(previous);
    store.touchUser(steamId, account.name, account.avatar ?? null, true);
    const id = auth.login(steamId, store.user(steamId)?.name ?? steamId);
    return { result: 'linked', cookie: cookie(id, 12 * 3600) };
  };

  const linking = createLinking(config, store, kv, {
    sessionOf: (req) => {
      const sid = parseCookies(req.headers.cookie)[COOKIE];
      return auth.session(sid) ? sid : undefined;
    },
    login: panelLogin,
    identity: (provider, account, panelSid) => {
      const s = auth.session(panelSid);
      if (!s) return 'expired';
      if (s.guest) return 'failed';
      if (provider === 'steam') return 'failed';
      if (!store.linkIdentity(s.steamId, provider, account.id, account.name)) return 'taken';
      console.log(`[관리자] ${s.name}(${s.steamId})에 ${provider} ${account.name} 연결`);
      return 'linked';
    },
    proven: (provider, account, previous) => {
      const s = auth.session(previous);
      if (!s || provider !== 'steam' || s.steamId === account.id) return null;
      console.log(`[관리자] 다른 스팀 계정(${account.name})으로 로그인해 ${s.name}의 패널 세션을 끝냈습니다`);
      endPanelSession(previous);
      return cookie('', 0);
    },
    canManage: (panelSid, serverId) => {
      const s = auth.session(panelSid);
      const srv = fleet.get(serverId);
      const role = s && !s.guest && srv && !srv.demo && roleOf(store, s, serverId, fleet);
      return !!role && hasRole(role, 'admin');
    },
    chzzkOwner: async (panelSid, serverId, token, channel) => {
      const s = auth.session(panelSid);
      if (!s) return 'expired';
      const srv = fleet.get(serverId);
      const role = srv && !s.guest && roleOf(store, s, serverId, fleet);
      if (!srv || srv.demo || !role || !hasRole(role, 'admin')) return 'denied';
      void subscribers.connect(srv, token, channel, s.name);
      srv.emit('action', srv.store.logAction(s.name, 'chzzk_owner_connect', channel.id, { name: channel.name }, true));
      console.log(`[치지직] #${srv.id} ${srv.name} 팔로워·구독 확인 채널 연결: ${channel.name} (${channel.id}) by ${s.name}`);
      return 'linked';
    },
    discordGuild: (panelSid, serverId, guild) => {
      const s = auth.session(panelSid);
      if (!s) return 'expired';
      const srv = fleet.get(serverId);
      const role = srv && !s.guest && roleOf(store, s, serverId, fleet);
      if (!srv || srv.demo || !role || !hasRole(role, 'admin')) return 'denied';
      store.setDiscordGuild(srv.id, guild);
      srv.emit('action', srv.store.logAction(s.name, 'discord_guild_connect', guild.id, { name: guild.name }, true));
      console.log(`[디스코드] #${srv.id} ${srv.name} 디스코드 서버 연결: ${guild.name} (${guild.id}) by ${s.name}`);
      return 'linked';
    },
  }, () => fleet.all().map((s) => ({
    id: s.id, name: s.name, joinCode: s.joinCode, public: s.public, demo: s.demo,
    status: () => ({
      online: s.poller.online,
      players: s.poller.players.length,
      maxPlayers: s.poller.status?.players?.max ?? null,
      map: s.poller.status?.map ?? null,
    }),
    entry: () => {
      const wl = s.store.whitelist();
      const rule = wl.mode === 'off' ? 'open' as const : wl.audience;
      return { rule, channel: rule === 'follower' || rule === 'subscriber' ? s.store.chzzkOwner()?.channelName ?? null : null };
    },
    passes: (link) => s.store.passes(link.chzzkChannelId),
  })), discord);
  linking.register(router);
  registerReports(router, { store, fleet, configured: linking.configured, accounts: linking.accounts, bot: discord.bot, imagesDir: join(dirname(config.dbPath), 'report-images') });
  registerServers(router, { store, fleet, hub, steam, configured: linking.configured });

  router.add('POST', '/api/logout', { public: true }, ({ sessionId, res }) => {
    endPanelSession(sessionId);
    res.setHeader('Set-Cookie', cookie('', 0));
    return { ok: true };
  });
  const mapArt = createMapArt(config.mapArtUrl);
  router.add('GET', '/api/map-art', { stream: true }, ({ query, res }) => mapArt.serve(query, res));
  router.add('GET', '/api/s/:sid/stream', { role: 'viewer', stream: true }, ({ req, res, session, sessionId, srv }) => {
    const client = hub.open(req, res, session, sessionId, srv.id);
    hub.send(client, 'capabilities', srv.poller.capabilitiesView());
    hub.send(client, 'live', srv.poller.snapshot());
    srv.poller.nudge();
  });

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const m = router.match(req.method, url.pathname);
    if (!m) return sendJson(res, 404, { error: { code: 'not_found', message: '없는 API입니다' } });
    if ('methodMismatch' in m) return sendJson(res, 405, { error: { code: 'method_not_allowed' } });
    const { route, params } = m;

    const sessionId = parseCookies(req.headers.cookie)[COOKIE];
    const session = auth.session(sessionId);
    let srv: ServerRuntime | null = null;
    let role: Role | null = null;
    if (!route.opts.public) {
      if (!session) throw new HttpError(401, 'unauthenticated', '로그인이 필요합니다');
      if (session.guest && (params.sid === undefined
        ? req.method !== 'GET' || !GUEST_GLOBAL.test(url.pathname)
        : req.method !== 'GET' && GUEST_BLOCKED.test(url.pathname))) {
        throw new HttpError(403, 'demo_forbidden', '데모 체험에서는 쓸 수 없는 기능입니다');
      }
      if (route.opts.superadmin && !session.superadmin) throw new HttpError(403, 'forbidden', '전체 관리자만 할 수 있습니다');
      if (params.sid !== undefined) {
        srv = fleet.get(Number(params.sid));
        role = srv && roleOf(store, session, srv.id, fleet);
        if (!srv || !role) throw new HttpError(404, 'no_server', '서버가 없거나 권한이 없습니다');
        const needed = route.opts.role ?? 'admin';
        if (!hasRole(role, needed)) throw new HttpError(403, 'forbidden', `이 작업은 ${needed} 이상 권한이 필요합니다`);
      }
    }
    if (req.method !== 'GET' && !route.opts.rawBody && req.headers[CSRF_HEADER] !== 'wardogs-dashboard') {
      throw new HttpError(403, 'csrf', '요청 헤더가 없습니다');
    }

    const body = req.method !== 'GET' && !route.opts.rawBody ? await readJson(req) : {};
    const result = await route.handler({
      req, res, params, query: url.searchParams, body, session: session as Session, sessionId,
      srv: srv as ServerRuntime, role: role as Role,
    });
    if (route.opts.stream) return;
    sendJson(res, 200, result ?? { ok: true }, SECURITY_HEADERS);
  }

  async function serveShell(dist: string, file: string, res: ServerResponse) {
    if (await serveStatic(dist, file, res)) return;
    sendJson(res, 503, { error: { code: 'not_built', message: '화면이 빌드되지 않았습니다. npm run build 를 먼저 실행하세요' } });
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/panel/demo' && req.method === 'GET') {
      endPanelSession(parseCookies(req.headers.cookie)[COOKIE]);
      const sid = auth.login(GUEST_STEAM_ID, GUEST_NAME, true);
      res.writeHead(302, { Location: '/panel', 'Set-Cookie': cookie(sid, 12 * 3600), 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      return res.end();
    }
    if (await linking.handle(url, req, res)) return;
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: { code: 'method_not_allowed' } });
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (PUBLIC_PAGES.has(path)) return serveShell(PUBLIC_DIST, '/index.html', res);
    if (POLICY_PAGES.has(path)) {
      res.writeHead(302, { Location: `${POLICY_URL}${path}`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      return res.end();
    }
    if (url.pathname.startsWith('/assets/') && await serveStatic(PUBLIC_DIST, url.pathname, res)) return;
    const page = /^\/([^/]{1,64})(\/report)?$/.exec(path);
    if (page && !RESERVED.has(page[1]!)) {
      let code = '';
      try {
        code = decodeURIComponent(page[1]!);
      } catch {}
      if (code && fleet.byJoinCode(code)) return serveShell(PUBLIC_DIST, '/index.html', res);
    }
    if (path === '/rcon') {
      res.writeHead(301, { Location: `/panel${url.search}`, ...SECURITY_HEADERS });
      return res.end();
    }
    if (path === '/panel' || url.pathname.startsWith('/panel/assets/')) {
      if (path === '/panel') return serveShell(ADMIN_DIST, '/admin.html', res);
      if (await serveStatic(ADMIN_DIST, url.pathname.slice('/panel'.length), res)) return;
    }
    notFound(url, res);
  }

  const onError = (res: ServerResponse) => (err: unknown) => {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { error: { code: err.code, message: err.message }, ...(err.extra ? { result: err.extra } : {}) });
    }
    if (err instanceof RconError) {
      const status = err.status === 429 ? 429 : err.status === 0 ? 504 : err.status === 412 ? 409 : err.code === 'bad_index' ? 400 : 502;
      return sendJson(res, status, { error: { code: err.code || 'rcon_error', message: err.message, upstreamStatus: err.status } });
    }
    console.error(err);
    sendJson(res, 500, { error: { code: 'internal', message: '서버 내부 오류' } });
  };

  const server = createServer((req, res) => handle(req, res).catch(onError(res)));

  return { server, auth, fleet, discord, linking, demo, subscribers };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const kv = await connectKv(config).catch((err) => {
    console.error(`[Redis] 연결하지 못해 시작을 멈춥니다: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
  console.log(`[Redis] ${config.redis.host}:${config.redis.port} db${config.redis.db}에 연결했습니다`);
  const app = createApp(config, kv);
  const servers = app.fleet.all().filter((s) => !s.demo);
  console.log(`게임 서버 ${servers.length}개: ${servers.map((s) => `#${s.id} ${s.name}`).join(', ') || '없음'}`);
  app.server.listen(config.port, config.host, () => {
    console.log(`Wardogs RCON 패널: http://${config.host}:${config.port}/panel`);
    console.log(`이벤트 피드 수신: http://<이 서버 주소>:${config.port}/api/ingest/events`);
  });
  app.fleet.start();
  app.demo.start(app.fleet);
  app.discord.start();
  app.subscribers.start();
  const shutdown = () => {
    app.subscribers.stop();
    app.fleet.stop();
    app.server.close();
    kv.close().catch(() => {}).finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

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
import { loadWeaponNames } from './weapons.ts';
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'wd_session';
const CSRF_HEADER = 'x-requested-with';
const PUBLIC_DIST = join(ROOT, 'dist/public');
const ADMIN_DIST = join(ROOT, 'dist/admin');
const PUBLIC_PAGES = new Set(['/', '/report']);
const RESERVED = new Set(['panel', 'rcon', 'report', 'assets', 'api', 'auth', 'callback', 'discord', 'terms', 'privacy']);
const POLICY_URL = 'https://insanephin.xyz/projects/wardogs-rcon';
const POLICY_PAGES = new Set(['/terms', '/privacy']);
// Guests may only read their own session info and use the demo server, minus settings that reach beyond it.
const GUEST_GLOBAL = /^\/api\/(me|servers|account|map-art)$/;
const GUEST_BLOCKED = /^\/api\/s\/\d+\/(server|members\/[^/]+|rcon|feed-token(\/rotate)?|links\/[^/]+)$/;

function notFound(url: URL, res: ServerResponse) {
  if (/^\/(rcon\/)?assets\//.test(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    return res.end('페이지를 찾을 수 없습니다');
  }
  res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
  res.end();
}

function createApp(config: Config) {
  const auth = new Auth(config.superadmins);
  const store = new Store(config.dbPath, { legacyFeedToken: config.feedToken, legacyDiscordServerId: config.discord.legacyServerId });
  const hub = new SseHub();
  const steam = createSteamProfiles(config.steam.apiKey);
  const weapons = loadWeaponNames(join(ROOT, 'data/weapons.json'));
  const demo = createDemo(store, weapons);
  const fleet = createFleet({
    store, hub, steam, weapons,
    gapSec: config.engagementGapSec,
    minKills: config.engagementMinKills,
    demoRcon: demo.rcon,
  });
  fleet.load();

  const router = new Router();
  const discord = createDiscord({ config, store, fleet, superadmins: auth.superadmins });
  registerApi(router, { fleet, store, config, discord, steam });
  discord.register(router);
  const clientIp = (req: IncomingMessage): string | undefined => {
    const cf = req.headers['cf-connecting-ip'];
    return config.trustProxy && typeof cf === 'string' && cf ? cf : req.socket.remoteAddress;
  };
  const adminAllowed = (req: IncomingMessage) => !config.adminAllowIps.length || config.adminAllowIps.includes(clientIp(req) ?? '');

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

  const linking = createLinking(config, store, {
    allowed: adminAllowed,
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
  }, () => fleet.all().filter((s) => !s.demo).map((s) => ({ id: s.id, name: s.name, joinCode: s.joinCode, public: s.public })), discord);
  linking.register(router);
  registerReports(router, { store, fleet, configured: linking.configured, accounts: linking.accounts });
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

    if (!route.opts.public && !adminAllowed(req)) {
      return sendJson(res, 404, { error: { code: 'not_found', message: '없는 API입니다' } });
    }
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
      if (!adminAllowed(req)) return notFound(url, res);
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
    if (path === '/rcon' && adminAllowed(req)) {
      res.writeHead(301, { Location: `/panel${url.search}`, ...SECURITY_HEADERS });
      return res.end();
    }
    if (path === '/panel' || url.pathname.startsWith('/panel/assets/')) {
      if (!adminAllowed(req)) return notFound(url, res);
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

  return { server, auth, fleet, discord, linking, demo };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = createApp(config);
  const servers = app.fleet.all().filter((s) => !s.demo);
  console.log(`게임 서버 ${servers.length}개: ${servers.map((s) => `#${s.id} ${s.name}`).join(', ') || '없음'}`);
  for (const s of servers) if (!s.rcon.baseUrl || !s.rcon.password) console.warn(`[경고] 서버 #${s.id} ${s.name}: RCON 연결 정보가 없습니다.`);
  if (!app.auth.superadmins.size) console.warn('[경고] SUPERADMIN_STEAM_IDS가 비어 있어 서버를 추가하거나 기존 서버를 관리할 사람이 없습니다.');
  if (!app.linking.configured.steam) console.warn('[경고] STEAM_WEB_API_KEY 또는 PUBLIC_URL이 비어 있어 관리자 패널에 로그인할 수 없습니다.');
  if (config.discord.botSecret && !app.discord.configured) console.warn('[경고] 디스코드 봇 인증을 쓰려면 PUBLIC_URL(또는 CHZZK_REDIRECT_URL)이 필요합니다.');
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.cookieSecure) {
    console.warn(`[안내] DASH_HOST=${config.host}. 이 포트를 다른 컴퓨터에 공개한다면 TLS 리버스 프록시 뒤에 두고 COOKIE_SECURE=true를 설정하세요.`);
  }
  app.server.listen(config.port, config.host, () => {
    console.log(`Wardogs RCON 패널: http://${config.host}:${config.port}/panel`);
    console.log(`이벤트 피드 수신: http://<이 서버 주소>:${config.port}/api/ingest/events`);
  });
  if (config.adminAllowIps.length) console.log(`관리자 허용 IP: ${config.adminAllowIps.join(', ')}`);
  app.fleet.start();
  app.demo.start(app.fleet);
  app.discord.start();
  const shutdown = () => {
    app.fleet.stop();
    app.server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

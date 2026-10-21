import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { Auth, hasRole } from './auth.ts';
import type { Session } from './auth.ts';
import { Router, HttpError, SseHub, sendJson, readJson, parseCookies, serveStatic, SECURITY_HEADERS } from './http.ts';
import { RconClient, RconError } from './rcon.ts';
import { Store } from './store.ts';
import { FeedProcessor } from './feed.ts';
import { Poller } from './poller.ts';
import { loadWeaponNames } from './weapons.ts';
import { registerApi } from './api.ts';
import { createLinking } from './link.ts';
import { registerReports } from './report.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'wd_session';
const CSRF_HEADER = 'x-requested-with';
const PUBLIC_DIST = join(ROOT, 'dist/public');
const ADMIN_DIST = join(ROOT, 'dist/admin');
const PUBLIC_PAGES = new Set(['/', '/report']);
const POLICY_URL = 'https://insanephin.xyz/projects/wardogs-rcon';
const POLICY_PAGES = new Set(['/terms', '/privacy']);

function notFound(url: URL, res: ServerResponse) {
  if (/^\/(rcon\/)?assets\//.test(url.pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    return res.end('페이지를 찾을 수 없습니다');
  }
  res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
  res.end();
}

export function createApp(config: Config) {
  const auth = new Auth(config.admins);
  const store = new Store(config.dbPath);
  const hub = new SseHub();
  const rcon = new RconClient({ baseUrl: config.rconUrl, password: config.rconPassword });

  let poller: Poller;
  const feed = new FeedProcessor({
    store,
    weapons: loadWeaponNames(join(ROOT, 'data/weapons.json')),
    gapSec: config.engagementGapSec,
    minKills: config.engagementMinKills,
    factionOf: (id: string) => poller.factionOf(id),
    emit: (event, data) => hub.broadcast(event, data),
  });
  poller = new Poller({ rcon, store, feed, emit: (e, d) => hub.broadcast(e, d), watchers: () => hub.size });

  const router = new Router();
  registerApi(router, { rcon, store, poller, feed, hub, config });
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
  const linking = createLinking(config, store, {
    allowed: adminAllowed,
    sessionOf: (req) => {
      const sid = parseCookies(req.headers.cookie)[COOKIE];
      return auth.session(sid) ? sid : undefined;
    },
    login: (account, previous) => {
      endPanelSession(previous);
      const id = auth.login(account.id, account.name);
      return { ok: !!id, cookie: id ? cookie(id, 12 * 3600) : previous ? cookie('', 0) : null };
    },
    proven: (account, previous) => {
      const s = auth.session(previous);
      if (!s || s.channelId === account.id) return null;
      console.log(`[관리자] 다른 치지직 계정(${account.name})으로 로그인해 ${s.name}의 패널 세션을 끝냈습니다`);
      endPanelSession(previous);
      return cookie('', 0);
    },
  });
  linking.register(router);
  registerReports(router, { store, poller, hub, configured: linking.configured, accounts: linking.accounts });

  router.add('POST', '/api/logout', { public: true }, ({ sessionId, res }) => {
    endPanelSession(sessionId);
    res.setHeader('Set-Cookie', cookie('', 0));
    return { ok: true };
  });
  router.add('GET', '/api/me', { role: 'viewer' }, ({ session }) => ({ name: session.name, role: session.role }));
  router.add('GET', '/api/stream', { role: 'viewer', stream: true }, ({ req, res, session, sessionId }) => {
    const client = hub.open(req, res, session, sessionId);
    hub.send(client, 'capabilities', poller.capabilitiesView());
    hub.send(client, 'live', poller.snapshot());
    poller.nudge();
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
    if (!route.opts.public) {
      if (!session) throw new HttpError(401, 'unauthenticated', '로그인이 필요합니다');
      if (!hasRole(session, route.opts.role ?? 'admin')) throw new HttpError(403, 'forbidden', `이 작업은 ${route.opts.role} 이상 권한이 필요합니다`);
    }
    if (req.method !== 'GET' && !route.opts.rawBody && req.headers[CSRF_HEADER] !== 'wardogs-dashboard') {
      throw new HttpError(403, 'csrf', '요청 헤더가 없습니다');
    }

    const body = req.method !== 'GET' && !route.opts.rawBody ? await readJson(req) : {};
    const result = await route.handler({ req, res, params, query: url.searchParams, body, session: session as Session, sessionId });
    if (route.opts.stream) return;
    sendJson(res, 200, result ?? { ok: true }, SECURITY_HEADERS);
  }

  async function serveShell(dist: string, file: string, res: ServerResponse) {
    if (await serveStatic(dist, file, res)) return;
    sendJson(res, 503, { error: { code: 'not_built', message: '화면이 빌드되지 않았습니다. npm run build 를 먼저 실행하세요' } });
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
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
    if (path === '/rcon' || url.pathname.startsWith('/rcon/assets/')) {
      if (!adminAllowed(req)) return notFound(url, res);
      if (path === '/rcon') return serveShell(ADMIN_DIST, '/admin.html', res);
      if (await serveStatic(ADMIN_DIST, url.pathname.slice('/rcon'.length), res)) return;
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

  return { server, auth, poller };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = createApp(config);
  if (!config.rconPassword) console.warn('[경고] RCON_PASSWORD가 비어 있습니다. 게임 서버가 인증을 거부할 것입니다.');
  if (!config.feedToken) console.warn('[경고] FEED_TOKEN이 비어 있어 이벤트 피드를 받지 않습니다.');
  if (!app.auth.admins.size) console.warn('[경고] ADMIN_CHZZK_IDS가 비어 있어 아무도 관리자 패널에 로그인할 수 없습니다.');
  if (!config.chzzk.clientId || !config.chzzk.clientSecret || !config.chzzk.redirectUrl) {
    console.warn('[경고] 치지직 앱 설정이 비어 있어 관리자 패널에 로그인할 수 없습니다.');
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.cookieSecure) {
    console.warn(`[안내] DASH_HOST=${config.host}. 이 포트를 다른 컴퓨터에 공개한다면 TLS 리버스 프록시 뒤에 두고 COOKIE_SECURE=true를 설정하세요.`);
  }
  app.server.listen(config.port, config.host, () => {
    console.log(`WARDOGS 대시보드: http://${config.host}:${config.port}/rcon`);
    console.log(`RCON 대상: ${config.rconUrl}`);
    console.log(`이벤트 피드 수신: http://<이 서버 주소>:${config.port}/api/ingest/events`);
  });
  if (config.adminAllowIps.length) console.log(`관리자 허용 IP: ${config.adminAllowIps.join(', ')}`);
  app.poller.start();
  const shutdown = () => {
    app.poller.stop();
    app.server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

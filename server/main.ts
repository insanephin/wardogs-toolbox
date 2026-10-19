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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COOKIE = 'wd_session';
// Cross-site pages cannot set custom headers, so requiring one blocks CSRF on writes.
const CSRF_HEADER = 'x-requested-with';

export function createApp(config: Config) {
  if (!config.users) throw new Error('DASH_USERS is empty; set at least one name:role:password');
  const auth = new Auth(config.users);
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

  const cookie = (value: string, maxAge: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`;

  router.add('POST', '/api/login', { public: true }, async ({ body, req, res }) => {
    const r = auth.login(String(body.name ?? ''), body.password, req.socket.remoteAddress);
    if (r.error === 'too_many_attempts') throw new HttpError(429, r.error, '로그인 실패가 반복돼 1분간 잠겼습니다');
    if (r.error) throw new HttpError(401, r.error, '이름 또는 비밀번호가 틀렸습니다');
    res.setHeader('Set-Cookie', cookie(r.id, 12 * 3600));
    return r.user;
  });
  router.add('POST', '/api/logout', { public: true }, ({ sessionId, res }) => {
    auth.logout(sessionId);
    hub.closeSession(sessionId);
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

  // Forwards account-link callbacks to the bot. Cookies are not passed on, so the bot never sees
  // an admin session, and a missing bot is a plain 404 rather than the dashboard's login page.
  async function proxyCallback(url: URL, req: IncomingMessage, res: ServerResponse) {
    if (!config.botUrl || req.method !== 'GET') return sendJson(res, 404, { error: { code: 'not_found' } });
    let upstream;
    try {
      upstream = await fetch(config.botUrl + url.pathname + url.search, { signal: AbortSignal.timeout(20000) });
    } catch {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('연동 서버에 연결할 수 없습니다. 잠시 후 디스코드에서 다시 시도해주세요.');
    }
    res.writeHead(upstream.status, {
      ...SECURITY_HEADERS,
      // The result page is static HTML with inline styles and no scripts.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'Content-Type': upstream.headers.get('content-type') || 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The OAuth code and state are in this URL; keep them out of other sites' logs.
      'Referrer-Policy': 'no-referrer',
    });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/callback/')) return proxyCallback(url, req, res);
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: { code: 'method_not_allowed' } });
      if (await serveStatic(join(ROOT, 'dist'), url.pathname, res)) return;
      // Unknown paths fall back to the app shell so deep links work.
      if (await serveStatic(join(ROOT, 'dist'), '/index.html', res)) return;
      return sendJson(res, 404, { error: { code: 'not_built', message: '화면이 빌드되지 않았습니다. npm run build 를 먼저 실행하세요' } });
    }

    const m = router.match(req.method, url.pathname);
    if (!m) return sendJson(res, 404, { error: { code: 'not_found', message: '없는 API입니다' } });
    if ('methodMismatch' in m) return sendJson(res, 405, { error: { code: 'method_not_allowed' } });
    const { route, params } = m;

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
    // session is null only on public routes, which never read it.
    const result = await route.handler({ req, res, params, query: url.searchParams, body, session: session as Session, sessionId });
    if (route.opts.stream) return;
    sendJson(res, 200, result ?? { ok: true }, SECURITY_HEADERS);
  }

  const onError = (res: ServerResponse) => (err: unknown) => {
    if (res.headersSent) return res.end();
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { error: { code: err.code, message: err.message }, ...(err.extra ? { result: err.extra } : {}) });
    }
    if (err instanceof RconError) {
      // Upstream failures: the game server refused or was unreachable. A stale config revision is a
      // conflict the admin can retry, and a check the client made before sending is the caller's fault.
      const status = err.status === 429 ? 429 : err.status === 0 ? 504 : err.status === 412 ? 409 : err.code === 'bad_index' ? 400 : 502;
      return sendJson(res, status, { error: { code: err.code || 'rcon_error', message: err.message, upstreamStatus: err.status } });
    }
    console.error(err);
    sendJson(res, 500, { error: { code: 'internal', message: '서버 내부 오류' } });
  };

  const server = createServer((req, res) => handle(req, res).catch(onError(res)));

  return { server, auth, store, poller, feed, hub, rcon };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const app = createApp(config);
  if (!config.rconPassword) console.warn('[경고] RCON_PASSWORD가 비어 있습니다. 게임 서버가 인증을 거부할 것입니다.');
  if (!config.feedToken) console.warn('[경고] FEED_TOKEN이 비어 있어 이벤트 피드를 받지 않습니다.');
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.cookieSecure) {
    console.warn(`[안내] DASH_HOST=${config.host}. 이 포트를 다른 컴퓨터에 공개한다면 TLS 리버스 프록시 뒤에 두고 COOKIE_SECURE=true를 설정하세요.`);
  }
  app.server.listen(config.port, config.host, () => {
    console.log(`WARDOGS 대시보드: http://${config.host}:${config.port}`);
    console.log(`RCON 대상: ${config.rconUrl}`);
    console.log(`이벤트 피드 수신: http://<이 서버 주소>:${config.port}/api/ingest/events`);
  });
  app.poller.start();
  const shutdown = () => {
    app.poller.stop();
    app.server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

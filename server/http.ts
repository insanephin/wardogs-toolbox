import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import type { Role, Session } from './auth.ts';
import type { ServerRuntime } from './fleet.ts';

export class HttpError extends Error {
  status: number;
  code: string;
  extra: unknown;

  constructor(status: number, code: string, message?: string, extra?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body_too_large', `요청 본문이 ${limit}바이트를 넘습니다`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export type Body = Record<string, any>;

export async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<Body> {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'bad_json', 'JSON 형식이 아닙니다');
  }
}

export const STEAM_ID = /^\d{17}$/;

export function requireSteamId(id: string): string {
  if (!STEAM_ID.test(id)) throw new HttpError(400, 'bad_steam_id', 'SteamID64(17자리 숫자)가 아닙니다');
  return id;
}

export function requireText(value: unknown, field: string, max: number, { optional = false } = {}): string {
  const s = typeof value === 'string' ? value.trim() : '';
  const n = [...s].length;
  if (!s && !optional) throw new HttpError(400, 'missing_field', `${field}을(를) 입력하세요`);
  if (n > max) throw new HttpError(400, 'too_long', `${field}은(는) 최대 ${max}자입니다 (현재 ${n}자)`);
  return s;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new HttpError(400, 'bad_encoding', '잘못된 URL 인코딩입니다');
  }
}

export function parseCookies(header = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
}

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Body;
  session: Session;
  sessionId: string | undefined;
  srv: ServerRuntime;
  role: Role;
}

interface RouteOptions {
  role?: Role;
  public?: boolean;
  superadmin?: boolean;
  stream?: boolean;
  rawBody?: boolean;
}

export type Handler = (ctx: RouteContext) => unknown;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  opts: RouteOptions;
  handler: Handler;
}

export class Router {
  routes: Route[] = [];

  add(method: string, pattern: string, opts: RouteOptions, handler: Handler): void {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([^/]+)')) + '$');
    this.routes.push({ method, re, keys, opts, handler });
  }

  match(method: string | undefined, path: string): { route: Route; params: Record<string, string> } | { methodMismatch: true } | null {
    let methodMismatch = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== method) {
        methodMismatch = true;
        continue;
      }
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decode(m[i + 1] ?? '')));
      return { route: r, params };
    }
    return methodMismatch ? { methodMismatch: true } : null;
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json']);
const compressed = new Map<string, Buffer>();

function encode(file: string, version: string, data: Buffer, accept: string): { data: Buffer; encoding?: string } {
  if (!COMPRESSIBLE.has(extname(file)) || data.length < 1024) return { data };
  const encoding = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  if (!encoding) return { data };
  const key = `${encoding}:${file}:${version}`;
  let out = compressed.get(key);
  if (!out) {
    out = encoding === 'br'
      ? brotliCompressSync(data, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9, [zlib.BROTLI_PARAM_SIZE_HINT]: data.length } })
      : gzipSync(data, { level: 9 });
    compressed.set(key, out);
  }
  return { data: out, encoding };
}

export async function serveStatic(root: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const base = resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return false;
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  let file = resolve(join(base, rel || 'index.html'));
  if (!file.startsWith(base + sep)) return false;
  try {
    let info = await stat(file);
    if (info.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file);
    }
    const body = encode(file, `${info.mtimeMs}:${info.size}`, await readFile(file), String(res.req?.headers['accept-encoding'] ?? ''));
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': rel.startsWith(`assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
      Vary: 'Accept-Encoding',
      ...(body.encoding ? { 'Content-Encoding': body.encoding } : {}),
      ...SECURITY_HEADERS,
    });
    res.end(body.data);
    return true;
  } catch {
    return false;
  }
}

const MAX_STREAMS_PER_SESSION = 4;
const MAX_GUEST_STREAMS = 200;

interface SseClient {
  res: ServerResponse;
  session: Session;
  sessionId: string | undefined;
  serverId: number;
}

export class SseHub {
  clients = new Set<SseClient>();
  heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.res.write(': ping\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  watching(serverId: number): number {
    let n = 0;
    for (const c of this.clients) if (c.serverId === serverId) n++;
    return n;
  }

  open(req: IncomingMessage, res: ServerResponse, session: Session, sessionId: string | undefined, serverId: number): SseClient {
    const mine = [...this.clients].filter((c) => c.sessionId === sessionId);
    for (const c of mine.slice(0, Math.max(0, mine.length - MAX_STREAMS_PER_SESSION + 1))) {
      c.res.end();
      this.clients.delete(c);
    }
    if (session.guest && [...this.clients].filter((c) => c.session.guest).length >= MAX_GUEST_STREAMS) {
      throw new HttpError(503, 'demo_busy', '데모 체험 접속이 많습니다. 잠시 후 다시 시도하세요');
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = { res, session, sessionId, serverId };
    this.clients.add(client);
    req.on('close', () => this.clients.delete(client));
    return client;
  }

  close(match: (c: SseClient) => boolean): void {
    for (const c of this.clients) {
      if (match(c)) {
        c.res.end();
        this.clients.delete(c);
      }
    }
  }

  send(client: SseClient, event: string, data: unknown): void {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  closeSession(sessionId: string | undefined): void {
    this.close((c) => c.sessionId === sessionId);
  }

  broadcast(serverId: number, event: string, data: unknown): void {
    if (!this.clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      if (c.serverId !== serverId) continue;
      if (c.session.expires < Date.now()) {
        c.res.end();
        this.clients.delete(c);
        continue;
      }
      c.res.write(frame);
    }
  }
}

export type Emit = (event: string, data: unknown) => void;

export function tokenMatches(given: string, expected: string): boolean {
  if (!expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

import type { IncomingMessage, ServerResponse, OutgoingHttpHeaders } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import type { Role, Session } from './auth.ts';

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

// Request bodies are untrusted JSON; handlers check each field they read.
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

export function parseCookies(header = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Body;
  session: Session;
  sessionId: string | undefined;
}

export interface RouteOptions {
  role?: Role;
  public?: boolean;
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
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
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
  '.json': 'application/json; charset=utf-8',
};

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

export async function serveStatic(root: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const base = resolve(root);
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  let file = resolve(join(base, rel || 'index.html'));
  if (!file.startsWith(base)) return false;
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export interface SseClient {
  res: ServerResponse;
  session: Session;
  sessionId: string | undefined;
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

  get size(): number {
    return this.clients.size;
  }

  open(req: IncomingMessage, res: ServerResponse, session: Session, sessionId: string | undefined): SseClient {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client = { res, session, sessionId };
    this.clients.add(client);
    req.on('close', () => this.clients.delete(client));
    return client;
  }

  closeSession(sessionId: string | undefined): void {
    for (const c of this.clients) {
      if (c.sessionId === sessionId) {
        c.res.end();
        this.clients.delete(c);
      }
    }
  }

  send(client: SseClient, event: string, data: unknown): void {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(event: string, data: unknown): void {
    if (!this.clients.size) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
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

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

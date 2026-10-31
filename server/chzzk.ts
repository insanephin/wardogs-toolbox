import type { Config } from './config.ts';
import type { ChzzkOwner } from './store.ts';
import type { Fleet, ServerRuntime } from './fleet.ts';
import { errorMessage } from './http.ts';

const CHZZK_API = 'https://openapi.chzzk.naver.com';
const TIMEOUT_MS = 10_000;
const SYNC_EVERY_MS = 3 * 60_000;
const REFRESH_BEFORE_MS = 6 * 3600_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 400;

export interface ChzzkToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

class ChzzkError extends Error {}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${CHZZK_API}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body: any = await res.json().catch(() => null);
  if (body?.code !== 200) throw new ChzzkError(`${path} ${res.status} ${JSON.stringify(body)}`);
  return body.content;
}

const post = (path: string, body: unknown) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function toToken(c: any): ChzzkToken {
  if (!c?.accessToken) throw new ChzzkError(`chzzk token ${JSON.stringify(c)}`);
  return { accessToken: c.accessToken, refreshToken: c.refreshToken ?? '', expiresAt: Date.now() + (Number(c.expiresIn) || 86400) * 1000 };
}

export async function chzzkToken(config: Config, code: string, state: string): Promise<ChzzkToken> {
  const { clientId, clientSecret } = config.chzzk;
  return toToken(await post('/auth/v1/token', { grantType: 'authorization_code', clientId, clientSecret, code, state }));
}

async function chzzkRefresh(config: Config, refreshToken: string): Promise<ChzzkToken> {
  const { clientId, clientSecret } = config.chzzk;
  return toToken(await post('/auth/v1/token', { grantType: 'refresh_token', clientId, clientSecret, refreshToken }));
}

export async function chzzkMe(accessToken: string): Promise<{ id: string; name: string }> {
  const u = await call('/open/v1/users/me', { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!u?.channelId) throw new ChzzkError(`chzzk users/me ${JSON.stringify(u)}`);
  return { id: u.channelId, name: u.channelName };
}

export function chzzkRevoke(config: Config, token: string, hint: 'access_token' | 'refresh_token'): void {
  const { clientId, clientSecret } = config.chzzk;
  post('/auth/v1/token/revoke', { clientId, clientSecret, token, tokenTypeHint: hint }).catch(() => {});
}

async function subscribers(accessToken: string): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ page: String(page), size: String(PAGE_SIZE) });
    const c = await call(`/open/v1/channels/subscribers?${q}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data: any[] = Array.isArray(c?.data) ? c.data : [];
    for (const s of data) if (s?.channelId) ids.push(String(s.channelId));
    if (data.length < PAGE_SIZE) return ids;
  }
  throw new ChzzkError(`구독자가 ${PAGE_SIZE * MAX_PAGES}명을 넘어 목록을 끝까지 받지 못했습니다`);
}

export function ownerView(o: ChzzkOwner | null) {
  return o && { channelId: o.channelId, channelName: o.channelName, connectedAt: o.connectedAt, syncedAt: o.syncedAt, count: o.count, error: o.error };
}

export function createChzzkSubscribers(config: Config, fleet: Fleet) {
  const running = new Map<number, Promise<void>>();
  let timer: NodeJS.Timeout | undefined;

  const still = (srv: ServerRuntime, o: ChzzkOwner) => srv.store.chzzkOwner()?.connectedAt === o.connectedAt;

  async function run(srv: ServerRuntime): Promise<void> {
    let owner = srv.store.chzzkOwner();
    if (!owner) return;
    try {
      if (owner.expiresAt - Date.now() < REFRESH_BEFORE_MS) {
        const token = await chzzkRefresh(config, owner.refreshToken);
        if (!still(srv, owner)) return;
        owner = { ...owner, ...token };
        srv.store.setChzzkOwner(owner);
      }
      const ids = await subscribers(owner.accessToken);
      if (!still(srv, owner)) return;
      srv.store.replaceSubscribers(ids);
      srv.store.setChzzkOwner({ ...owner, syncedAt: Date.now(), count: ids.length, error: null });
      srv.poller.nudge();
    } catch (err) {
      const message = errorMessage(err);
      console.error(`[치지직] #${srv.id} ${srv.name} 구독자 동기화 실패: ${message}`);
      const latest = srv.store.chzzkOwner();
      if (latest?.connectedAt === owner.connectedAt) srv.store.setChzzkOwner({ ...latest, error: message });
    }
  }

  function sync(srv: ServerRuntime): Promise<void> {
    let p = running.get(srv.id);
    if (!p) {
      p = run(srv).finally(() => running.delete(srv.id));
      running.set(srv.id, p);
    }
    return p;
  }

  function connect(srv: ServerRuntime, token: ChzzkToken, channel: { id: string; name: string }, by: string): Promise<void> {
    const prev = srv.store.chzzkOwner();
    if (prev && prev.refreshToken !== token.refreshToken) chzzkRevoke(config, prev.refreshToken, 'refresh_token');
    srv.store.setChzzkOwner({
      ...token, channelId: channel.id, channelName: channel.name, connectedBy: by, connectedAt: Date.now(), syncedAt: null, count: 0, error: null,
    });
    if (prev?.channelId !== channel.id) srv.store.replaceSubscribers([]);
    return (running.get(srv.id) ?? Promise.resolve()).then(() => sync(srv));
  }

  function disconnect(srv: ServerRuntime): void {
    const prev = srv.store.chzzkOwner();
    if (prev) chzzkRevoke(config, prev.refreshToken, 'refresh_token');
    srv.store.setChzzkOwner(null);
    srv.store.replaceSubscribers([]);
  }

  return {
    sync,
    connect,
    disconnect,
    start() {
      const tick = () => {
        for (const srv of fleet.all()) if (!srv.demo) sync(srv);
      };
      tick();
      timer = setInterval(tick, SYNC_EVERY_MS);
    },
    stop() {
      clearInterval(timer);
    },
  };
}

export type ChzzkSubscribers = ReturnType<typeof createChzzkSubscribers>;

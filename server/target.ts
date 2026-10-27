import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { HttpError } from './http.ts';
import { RconClient } from './rcon.ts';
import type { RconError } from './rcon.ts';
import type { Session } from './auth.ts';

const PROBES_PER_WINDOW = 10;
const PROBE_WINDOW_MS = 10 * 60_000;

const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

function isPrivate(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, 'ipv4');
  return PRIVATE.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

async function requirePublicHost(url: string): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new HttpError(400, 'bad_rcon_host', '주소를 찾을 수 없습니다. 호스트 이름을 확인하세요');
  }
  if (!addresses.length || addresses.some(isPrivate)) {
    throw new HttpError(400, 'private_rcon_host', '내부망·사설 IP 주소는 쓸 수 없습니다. 게임 서버의 공인 IP나 도메인을 입력하세요');
  }
}

export async function probeRcon(url: string, password: string, { allowPrivate = false } = {}): Promise<{ gameName: string | null }> {
  if (!allowPrivate) await requirePublicHost(url);
  const rcon = new RconClient({ baseUrl: url, password, timeoutMs: 6000 });
  try {
    await rcon.loadCapabilities();
    const status = await rcon.status();
    return { gameName: status.serverName ?? null };
  } catch (err) {
    const e = err as RconError;
    if (e.status === 401 || e.status === 403) throw new HttpError(400, 'rcon_auth', 'RCON 비밀번호가 맞지 않습니다');
    if (e.code === 'timeout' || e.code === 'unreachable') {
      throw new HttpError(400, 'rcon_unreachable', '서버에 연결할 수 없습니다. 주소·RCON 포트(기본 7776)·방화벽, AllowedHosts 설정을 확인하세요');
    }
    if (e.status === 429) throw new HttpError(429, 'rcon_rate_limited', '게임 서버가 요청 한도를 넘었다고 답했습니다. 잠시 후 다시 시도하세요');
    throw new HttpError(400, 'rcon_invalid', '응답이 워독스 RCON 서버가 아닙니다. 주소와 포트를 확인하세요');
  }
}

const probes = new Map<string, number[]>();
export function throttleProbe(session: Session): void {
  if (session.superadmin) return;
  const now = Date.now();
  const recent = (probes.get(session.steamId) ?? []).filter((t) => now - t < PROBE_WINDOW_MS);
  if (recent.length >= PROBES_PER_WINDOW) throw new HttpError(429, 'too_many_probes', '연결 시도가 너무 많습니다. 10분 뒤 다시 시도하세요');
  recent.push(now);
  probes.set(session.steamId, recent);
}

export function requireRconUrl(v: unknown): string {
  const bad = () => new HttpError(400, 'bad_rcon_url', 'RCON 주소는 http://호스트:포트 형식이어야 합니다');
  if (typeof v !== 'string' || !v.trim() || v.length > 300) throw bad();
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw bad();
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) throw bad();
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

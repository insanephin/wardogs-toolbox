import { createClient } from 'redis';
import type { Config } from './config.ts';

export interface Kv {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  take<T>(key: string): Promise<T | null>;
  del(key: string): Promise<void>;
  close(): Promise<void>;
}

const parse = <T>(raw: string | null): T | null => (raw == null ? null : JSON.parse(raw) as T);

export async function connectKv({ redis }: Config): Promise<Kv> {
  if (!redis.host) throw new Error('REDIS_HOST가 비어 있습니다. 로그인 세션·인증 티켓을 Redis에 저장하므로 꼭 필요합니다');
  let connected = false;
  const client = createClient({
    socket: {
      host: redis.host, port: redis.port, connectTimeout: 5000,
      reconnectStrategy: (retries, cause) => (connected ? Math.min(retries * 200, 5000) : cause),
    },
    password: redis.password || undefined,
    database: redis.db,
    disableOfflineQueue: true,
  });
  let down = false;
  client.on('error', (err) => {
    if (!down) console.error(`[Redis] 연결 오류: ${err instanceof Error ? err.message : err}`);
    down = true;
  });
  client.on('ready', () => {
    if (down) console.log('[Redis] 다시 연결했습니다');
    down = false;
  });
  await client.connect();
  connected = true;
  const k = (key: string) => `${redis.prefix}${key}`;

  return {
    get: async (key) => parse(await client.get(k(key))),
    set: async (key, value, ttlMs) => {
      await client.set(k(key), JSON.stringify(value), { expiration: { type: 'PX', value: Math.max(1, Math.ceil(ttlMs)) } });
    },
    take: async (key) => parse(await client.getDel(k(key))),
    del: async (key) => {
      await client.del(k(key));
    },
    close: async () => {
      await client.close();
    },
  };
}

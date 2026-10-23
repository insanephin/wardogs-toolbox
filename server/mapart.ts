import type { ServerResponse } from 'node:http';
import { HttpError, SECURITY_HEADERS } from './http.ts';

const TIMEOUT_MS = 10_000;
const MISS_TTL_MS = 3600_000;
const MAX_ENTRIES = 300;
const MAX_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9_]{1,64}$/;
const VARIANTS = new Set(['square', 'wide', '720']);
const FALLBACK_LIGHTING = 'DayClear';
const ALIAS: Record<string, string> = {
  Kavkazi: 'Bakurani', Bakurani: 'Kavkazi',
  Europe: 'Ozeti', Ozeti: 'Europe',
  NorthAmerica: 'Zestafona', Zestafona: 'NorthAmerica',
};

interface Art {
  type: string;
  data: Buffer;
}

export function createMapArt(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, '');
  const hits = new Map<string, Art>();
  const misses = new Map<string, number>();
  const inflight = new Map<string, Promise<Art | null>>();

  function candidates(map: string, lighting: string, variant: string): string[] {
    const dirs = [map, ALIAS[map]].filter((d): d is string => !!d);
    const lights = [...new Set([lighting, FALLBACK_LIGHTING].filter(Boolean))];
    const out: string[] = [];
    for (const light of lights) for (const dir of dirs) out.push(`${base}/${dir}/${light}-${variant}.webp`);
    for (const dir of dirs) out.push(`${base}/${dir}.jpg`);
    return out;
  }

  async function download(url: string): Promise<Art | null> {
    const missAt = misses.get(url);
    if (missAt && Date.now() - missAt < MISS_TTL_MS) return null;
    const hit = hits.get(url);
    if (hit) return hit;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.startsWith('image/')) throw new Error(`${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > MAX_BYTES) throw new Error('too large');
      const art = { type, data };
      while (hits.size >= MAX_ENTRIES) hits.delete(hits.keys().next().value as string);
      hits.set(url, art);
      return art;
    } catch {
      while (misses.size >= MAX_ENTRIES * 4) misses.delete(misses.keys().next().value as string);
      misses.set(url, Date.now());
      return null;
    }
  }

  async function find(map: string, lighting: string, variant: string): Promise<Art | null> {
    for (const url of candidates(map, lighting, variant)) {
      let p = inflight.get(url);
      if (!p) {
        p = download(url).finally(() => inflight.delete(url));
        inflight.set(url, p);
      }
      const art = await p;
      if (art) return art;
    }
    return null;
  }

  async function serve(query: URLSearchParams, res: ServerResponse): Promise<void> {
    const map = query.get('map') || '';
    const lighting = query.get('lighting') || FALLBACK_LIGHTING;
    const variant = query.get('variant') || 'wide';
    if (!ID.test(map) || !ID.test(lighting) || !VARIANTS.has(variant)) throw new HttpError(400, 'bad_map_art', '맵 이미지 요청이 올바르지 않습니다');
    const art = base ? await find(map, lighting, variant) : null;
    if (!art) throw new HttpError(404, 'not_found', '이 맵의 이미지가 없습니다');
    res.writeHead(200, { 'Content-Type': art.type, 'Content-Length': art.data.length, 'Cache-Control': 'private, max-age=86400', ...SECURITY_HEADERS });
    res.end(art.data);
  }

  return { serve };
}

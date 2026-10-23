const API = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const TTL_MS = 6 * 3600_000;
const BATCH = 100;
const MAX_CACHE = 5000;
const TIMEOUT_MS = 10_000;

interface SteamProfile {
  name: string;
  avatar: string;
}

interface Cached extends SteamProfile {
  at: number;
}

export function createSteamProfiles(apiKey: string) {
  const cache = new Map<string, Cached>();
  const inflight = new Set<string>();

  async function refresh(ids: string[]) {
    const now = Date.now();
    const want = [...new Set(ids)].filter((id) => !inflight.has(id) && !(cache.get(id) && now - cache.get(id)!.at < TTL_MS));
    if (!apiKey || !want.length) return;
    for (const id of want) inflight.add(id);
    try {
      for (let i = 0; i < want.length; i += BATCH) {
        const chunk = want.slice(i, i + BATCH);
        const res = await fetch(`${API}?${new URLSearchParams({ key: apiKey, steamids: chunk.join(',') })}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error(`steam ${res.status}`);
        const players = ((await res.json()) as { response?: { players?: Record<string, string>[] } }).response?.players || [];
        for (const p of players) {
          cache.delete(p.steamid!);
          cache.set(p.steamid!, { name: p.personaname || '', avatar: p.avatarmedium || p.avatar || '', at: now });
        }
        while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
      }
    } finally {
      for (const id of want) inflight.delete(id);
    }
  }

  const cached = (id: string): SteamProfile | null => {
    const c = cache.get(id);
    return c ? { name: c.name, avatar: c.avatar } : null;
  };

  return {
    configured: !!apiKey,
    cached,
    warm(ids: string[]) {
      refresh(ids).catch(() => {});
    },
    async lookup(ids: string[]): Promise<Record<string, SteamProfile>> {
      await refresh(ids).catch(() => {});
      const out: Record<string, SteamProfile> = {};
      for (const id of ids) {
        const p = cached(id);
        if (p) out[id] = p;
      }
      return out;
    },
  };
}

export type SteamProfiles = ReturnType<typeof createSteamProfiles>;

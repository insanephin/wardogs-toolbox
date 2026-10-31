import { RconClient } from './rcon.ts';
import { FeedProcessor } from './feed.ts';
import { Poller } from './poller.ts';
import { tokenMatches } from './http.ts';
import type { Emit, SseHub } from './http.ts';
import type { Store, ServerStore, ServerRow } from './store.ts';
import type { WeaponLookup } from './weapons.ts';
import type { SteamProfiles } from './steam.ts';

const MAX_NAME = 40;

export const panelName = (gameName: string | null | undefined): string =>
  [...(gameName ?? '')].slice(0, MAX_NAME).join('').trim() || '새 서버';

export interface ServerRuntime {
  id: number;
  name: string;
  feedToken: string;
  readonly public: boolean;
  demo: boolean;
  joinCode: string | null;
  store: ServerStore;
  rcon: RconClient;
  feed: FeedProcessor;
  poller: Poller;
  emit: Emit;
  catalog: { at: number; data: Awaited<ReturnType<RconClient['catalog']>> | null };
}

interface FleetOptions {
  store: Store;
  hub: SseHub;
  steam: SteamProfiles;
  weapons: WeaponLookup;
  gapSec: number;
  minKills: number;
  demoRcon?: (row: ServerRow) => RconClient | null;
  trusted?: (row: ServerRow) => boolean;
}

export function createFleet({ store, hub, steam, weapons, gapSec, minKills, demoRcon, trusted = () => false }: FleetOptions) {
  const runtimes = new Map<number, ServerRuntime>();
  let running = false;

  function remember(rt: ServerRuntime, code: string): void {
    if (rt.joinCode === code) return;
    const other = [...runtimes.values()].find((r) => r !== rt && r.joinCode === code);
    if (other) return console.warn(`[서버] #${rt.id} ${rt.name}의 접속 ID ${code}가 이미 #${other.id} ${other.name}에 쓰이고 있어 공개 주소를 바꾸지 않았습니다`);
    store.updateServer(rt.id, { joinCode: code });
    rt.joinCode = code;
  }

  function rename(rt: ServerRuntime, gameName: string): void {
    const name = panelName(gameName);
    if (rt.name === name) return;
    store.updateServer(rt.id, { name });
    rt.name = name;
  }

  function spawn(row: ServerRow): ServerRuntime {
    const scoped = store.forServer(row.id);
    const emit: Emit = (event, data) => hub.broadcast(row.id, event, data);
    const fake = demoRcon?.(row) ?? null;
    const rcon = fake ?? new RconClient({ baseUrl: row.rconUrl, password: row.rconPassword, allowPrivate: trusted(row) });
    let poller: Poller;
    const feed = new FeedProcessor({
      store: scoped,
      weapons,
      gapSec,
      minKills,
      factionOf: (id: string) => poller.factionOf(id),
      emit,
      onMatchEnd: () => poller.onMatchEnd(),
    });
    poller = new Poller({ rcon, store: scoped, feed, emit, watchers: () => hub.watching(row.id), steam, onServerId: (code) => remember(rt, code), onServerName: (name) => rename(rt, name) });
    const rt: ServerRuntime = {
      id: row.id, name: row.name, feedToken: row.feedToken, joinCode: row.joinCode,
      demo: !!fake,
      get public() { return !fake && poller.passworded === false; },
      store: scoped, rcon, feed, poller, emit, catalog: { at: 0, data: null },
    };
    runtimes.set(row.id, rt);
    if (running) poller.start();
    return rt;
  }

  return {
    get: (id: number) => runtimes.get(id) ?? null,
    all: () => [...runtimes.values()],
    load() {
      for (const row of store.servers()) spawn(row);
    },
    start() {
      running = true;
      for (const rt of runtimes.values()) rt.poller.start();
    },
    stop() {
      running = false;
      for (const rt of runtimes.values()) rt.poller.stop();
    },
    add: spawn,
    refresh(id: number): ServerRuntime | null {
      const rt = runtimes.get(id);
      const row = store.server(id);
      if (!rt || !row) return rt ?? null;
      Object.assign(rt, { name: row.name, feedToken: row.feedToken });
      if (rt.rcon.baseUrl !== row.rconUrl || rt.rcon.password !== row.rconPassword) {
        rt.rcon.setTarget(row.rconUrl, row.rconPassword);
        rt.poller.nudge();
      }
      return rt;
    },
    remove(id: number): void {
      const rt = runtimes.get(id);
      if (!rt) return;
      rt.poller.stop();
      runtimes.delete(id);
      hub.close((c) => c.serverId === id);
    },
    byJoinCode(code: string): ServerRuntime | null {
      for (const rt of runtimes.values()) if (rt.joinCode === code) return rt;
      return null;
    },
    byFeedToken(token: string): ServerRuntime | null {
      for (const rt of runtimes.values()) if (tokenMatches(token, rt.feedToken)) return rt;
      return null;
    },
  };
}

export type Fleet = ReturnType<typeof createFleet>;

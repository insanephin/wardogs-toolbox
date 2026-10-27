import { useSyncExternalStore } from 'react';
import type { Action, CashHistory, Capabilities, Engagement, FeedEvent, Kill, Live, Me, Report, Role } from './types.ts';

const ROLE_RANK: Record<Role, number> = { viewer: 1, mod: 2, admin: 3, owner: 4 };
const SERVER_KEY = 'wd_server';

interface State {
  me: Me | null;
  serverId: number | null;
  live: Live | null;
  caps: Capabilities | null;
  colors: Record<string, string | undefined>;
  streamDown: boolean;
  kills: Kill[];
  engagements: Map<number, Engagement>;
  matchEvents: FeedEvent[];
  lastAction: Action | null;
  lastReport: Report | null;
  cash: CashHistory | null;
}

let state: State = {
  me: null,
  serverId: null,
  live: null,
  caps: null,
  colors: {},
  streamDown: false,
  kills: [],
  engagements: new Map(),
  matchEvents: [],
  lastAction: null,
  lastReport: null,
  cash: null,
};
const listeners = new Set<() => void>();

export const getState = () => state;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const currentServer = (s: State = state) => s.me?.servers.find((x) => x.id === s.serverId) ?? null;

export function can(role: Role, s: State = state): boolean {
  const r = currentServer(s)?.role;
  return !!r && ROLE_RANK[r] >= ROLE_RANK[role];
}

export function pickServer(me: Me, wanted?: number | null): number | null {
  let saved: number | null = null;
  try {
    saved = Number(localStorage.getItem(SERVER_KEY)) || null;
  } catch {}
  const ids = me.servers.map((s) => s.id);
  return [wanted, saved, ids[0]].find((id): id is number => id != null && ids.includes(id)) ?? null;
}

export function rememberServer(id: number): void {
  try {
    localStorage.setItem(SERVER_KEY, String(id));
  } catch {}
}

export function selectServer(id: number): void {
  rememberServer(id);
  setState({ serverId: id });
}

export function serves(caps: Capabilities | null, route: string): boolean {
  if (!caps) return true;
  const norm = (r: string) => r.replace(/\{[^}]+\}/g, '{}');
  return caps.routes.some((r) => norm(r) === norm(route));
}

const ENGAGEMENT_BUFFER = 200;

export function withEngagements(map: Map<number, Engagement>, list: Engagement[]): Map<number, Engagement> {
  const next = new Map(map);
  for (const g of list) next.set(g.id, g);
  if (next.size > ENGAGEMENT_BUFFER) {
    const old = [...next.values()].sort((a, b) => a.startedAt - b.startedAt).slice(0, next.size - ENGAGEMENT_BUFFER);
    for (const g of old) next.delete(g.id);
  }
  return next;
}

export function colorsFrom(live: Live | null, prev: State['colors']): State['colors'] {
  const next: State['colors'] = {};
  for (const f of live?.status?.factionScores || []) next[f.name] = f.colorHex;
  return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
}

// Shared app state fed by the live stream. Components read slices with useStore(selector);
// every write replaces the state object so selectors see new references.
import { useSyncExternalStore } from 'react';
import type { Action, Capabilities, Engagement, FeedEvent, Kill, Live, Me, Role } from './types.ts';

const ROLE_RANK: Record<Role, number> = { viewer: 1, mod: 2, admin: 3 };

export interface State {
  me: Me | null;
  live: Live | null;
  caps: Capabilities | null;
  // Faction name -> color. Kept referentially stable across polls so kill rows don't re-render.
  colors: Record<string, string | undefined>;
  streamDown: boolean;
  kills: Kill[];
  engagements: Map<number, Engagement>;
  matchEvents: FeedEvent[];
  // Newest dashboard action from the stream; useOnAction watches it.
  lastAction: Action | null;
}

let state: State = {
  me: null,
  live: null,
  caps: null,
  colors: {},
  streamDown: false,
  kills: [],
  engagements: new Map(),
  matchEvents: [],
  lastAction: null,
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

export function can(role: Role, me = state.me): boolean {
  return !!me && ROLE_RANK[me.role] >= ROLE_RANK[role];
}

// Route templates differ between builds ({id} vs {steamId}).
export function serves(caps: Capabilities | null, route: string): boolean {
  if (!caps) return true;
  const norm = (r: string) => r.replace(/\{[^}]+\}/g, '{}');
  return caps.routes.some((r) => norm(r) === norm(route));
}

const ENGAGEMENT_BUFFER = 200;

// Returns a new map with `list` merged in, dropping the oldest entries past the buffer.
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

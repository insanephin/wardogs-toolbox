import type { WeaponLookup } from './weapons.ts';
import type { ServerStore as Store, Kill, MatchEvent, OpenEngagement, Engagement } from './store.ts';
import type { Emit } from './http.ts';

const IGNORED_TAGS = new Set(['Kill', 'Death']);
const STORED_TYPES = new Set(['match_state', 'match_ended', 'player_joined', 'player_left']);
const CLOCK_RESET_SEC = 30;
const RESUME_MATCH_WITHIN_MS = 10 * 60 * 1000;

const isPostMatch = (state: string | undefined) => !!state?.startsWith('MatchState.PostMatch');

function shortTag(tag: unknown): string {
  return String(tag).replace(/^.*\./, '');
}

export interface FeedBatch {
  serverName?: string;
  events?: unknown;
}

interface FeedEvent extends MatchEvent {
  killerSteamId?: string;
  killerName?: string;
  victimSteamId?: string;
  victimName?: string;
  cause?: string;
  distance?: number;
  contextTags?: string[];
  state?: string;
  winningFaction?: string;
}

interface FeedOptions {
  store: Store;
  weapons: WeaponLookup;
  gapSec: number;
  minKills: number;
  factionOf: (steamId: string) => string | null;
  emit: Emit;
  onMatchEnd?: () => void;
}

export class FeedProcessor {
  store: Store;
  weapons: WeaponLookup;
  gapSec: number;
  minKills: number;
  factionOf: (steamId: string) => string | null;
  emit: Emit;
  onMatchEnd: () => void;

  matchKey: string | null = null;
  map: string | null = null;
  lastEventTime: number | null = null;
  engagement: OpenEngagement | null = null;
  matchState: { state: string | undefined; at: number; eventTime: number | null } | null = null;
  serverName: string | null = null;
  lastBatchAt: number | null = null;
  batches = 0;
  rejected = 0;
  unknownTypes = new Set<string>();

  constructor({ store, weapons, gapSec, minKills, factionOf, emit, onMatchEnd = () => {} }: FeedOptions) {
    this.onMatchEnd = onMatchEnd;
    this.store = store;
    this.weapons = weapons;
    this.gapSec = gapSec;
    this.minKills = minKills;
    this.factionOf = factionOf;
    this.emit = emit;

    const last = store.lastKill();
    const seen = store.lastMatchPlayer();
    if (last && Date.now() - last.receivedAt < RESUME_MATCH_WITHIN_MS && !(seen && seen.lastSeen > last.receivedAt && seen.matchKey !== last.matchKey)) {
      this.matchKey = last.matchKey;
      this.map = last.map;
      this.lastEventTime = last.eventTime;
    } else if (seen && Date.now() - seen.lastSeen < RESUME_MATCH_WITHIN_MS) {
      this.matchKey = seen.matchKey;
      this.map = seen.map;
    }
  }

  newMatch(map: string | null | undefined, at: number): void {
    this.engagement = null;
    this.map = map ?? this.map;
    this.matchKey = `${at.toString(36)}-${this.map ?? 'unknown'}`;
    this.lastEventTime = null;
    this.emit('match', { matchKey: this.matchKey, map: this.map });
  }

  onMapChange(map: string | undefined, at = Date.now()): void {
    if (map && map !== this.map) this.newMatch(map, at);
  }

  observeClock(map: string | undefined, eventTime: number | undefined, at: number): void {
    if (!this.matchKey || (map && this.map && map !== this.map)) {
      this.newMatch(map, at);
    } else if (eventTime != null && this.lastEventTime != null && eventTime < this.lastEventTime - CLOCK_RESET_SEC) {
      this.newMatch(map, at);
    }
    if (map) this.map = map;
    if (eventTime != null) this.lastEventTime = eventTime;
  }

  ingest(body: FeedBatch | null, receivedAt = Date.now()) {
    if (!body || !Array.isArray(body.events)) {
      this.rejected++;
      return { ok: false, error: 'events array missing' };
    }
    this.batches++;
    this.lastBatchAt = receivedAt;
    if (body.serverName) this.serverName = body.serverName;

    const wasPostMatch = isPostMatch(this.matchState?.state);
    let accepted = 0;
    let duplicates = 0;
    for (const e of body.events as FeedEvent[]) {
      if (!e || typeof e !== 'object' || !e.eventId || !e.type) continue;
      if (e.type !== 'killed' && !STORED_TYPES.has(e.type)) {
        this.noteUnknown(String(e.type));
        continue;
      }
      const fresh = e.type === 'killed' ? this.handleKill(e, receivedAt) : this.handleOther(e, receivedAt);
      if (fresh) accepted++;
      else duplicates++;
    }
    if (!wasPostMatch && isPostMatch(this.matchState?.state)) this.onMatchEnd();
    this.emit('feed', this.status());
    return { ok: true, accepted, duplicates };
  }

  noteUnknown(type: string): void {
    if (this.unknownTypes.has(type) || this.unknownTypes.size >= 50) return;
    this.unknownTypes.add(type);
    console.log(`[피드] 모르는 이벤트 종류 "${type.slice(0, 40)}"는 저장하지 않고 버립니다`);
  }

  handleKill(e: FeedEvent, at: number): boolean {
    if (this.store.hasKill(e.eventId)) return false;
    this.observeClock(e.mapName, e.eventTime, at);

    const tags = (e.contextTags || []).map(shortTag).filter((t) => !IGNORED_TAGS.has(t));
    const killer = e.killerSteamId || null;
    const victim = e.victimSteamId || null;
    const suicide = tags.includes('Suicide') || (killer && killer === victim);
    const killerFaction = killer ? this.factionOf(killer) : null;
    const victimFaction = victim ? this.factionOf(victim) : null;

    const kill: Kill = {
      eventId: e.eventId,
      receivedAt: at,
      matchKey: this.matchKey,
      map: e.mapName ?? this.map,
      eventTime: e.eventTime ?? null,
      killerSteamId: killer,
      killerName: e.killerName ?? null,
      killerFaction,
      victimSteamId: victim,
      victimName: e.victimName ?? null,
      victimFaction,
      cause: e.cause ?? null,
      weapon: this.weapons.name(e.cause),
      distanceM: typeof e.distance === 'number' ? Math.round(e.distance) / 100 : null,
      tags,
      headshot: tags.includes('Headshot'),
      suicide: !!suicide,
      teamkill: !suicide && !!killer && !!killerFaction && killerFaction === victimFaction,
      engagementId: null,
    };

    if (killer && !kill.suicide) this.assignEngagement(kill);
    this.store.insertKill(kill);
    this.emit('kill', kill);
    return true;
  }

  assignEngagement(kill: Kill): void {
    const e = this.engagement;
    const sameMatch = e && e.matchKey === kill.matchKey;
    const gap = sameMatch && kill.eventTime != null && e.endTime != null
      ? kill.eventTime - e.endTime
      : e ? (kill.receivedAt - e.endedAt) / 1000 : Infinity;
    if (!sameMatch || gap > this.gapSec || gap < -CLOCK_RESET_SEC) this.openEngagement(kill);

    const g = this.engagement!;
    g.endedAt = kill.receivedAt;
    g.endTime = kill.eventTime ?? g.endTime;
    g.kills++;
    if (kill.headshot) g.headshots++;
    if (kill.teamkill) g.teamkills++;
    if (kill.distanceM != null) {
      g.distanceSum += kill.distanceM;
      g.distanceN++;
    }
    const f = kill.killerFaction ?? '?';
    g.factions[f] = (g.factions[f] ?? 0) + 1;
    if (kill.killerSteamId) g.participants.add(kill.killerSteamId);
    if (kill.victimSteamId) g.participants.add(kill.victimSteamId);
    if (kill.weapon) g.weapons[kill.weapon] = (g.weapons[kill.weapon] ?? 0) + 1;
    kill.engagementId = g.id;
    this.store.saveEngagement(g);
    if (g.kills >= this.minKills) this.emit('engagement', publicEngagement(g));
  }

  openEngagement(kill: Kill): void {
    const id = this.store.createEngagement(kill.matchKey, kill.map, kill.receivedAt, kill.eventTime);
    this.engagement = {
      id,
      matchKey: kill.matchKey,
      map: kill.map,
      startedAt: kill.receivedAt,
      endedAt: kill.receivedAt,
      startTime: kill.eventTime,
      endTime: kill.eventTime,
      kills: 0,
      headshots: 0,
      teamkills: 0,
      distanceSum: 0,
      distanceN: 0,
      factions: {},
      participants: new Set(),
      weapons: {},
    };
  }

  handleOther(e: FeedEvent, at: number): boolean {
    if (!this.store.insertMatchEvent(e, at)) return false;
    if (e.type === 'match_state') {
      const prev = this.matchState?.state ?? '';
      if (e.state?.startsWith('MatchState.PreMatch') && !prev.startsWith('MatchState.PreMatch') && prev) {
        this.newMatch(e.mapName, at);
      }
      this.matchState = { state: e.state, at, eventTime: e.eventTime ?? null };
    } else if (e.type === 'match_ended') {
      if (this.matchKey) this.store.setMatchResult(this.matchKey, e.winningFaction, at);
    }
    if (e.mapName) this.map = this.map ?? e.mapName;
    this.emit('matchEvent', { ...e, receivedAt: at });
    return true;
  }

  status() {
    return {
      serverName: this.serverName,
      lastBatchAt: this.lastBatchAt,
      batches: this.batches,
      rejected: this.rejected,
      matchKey: this.matchKey,
      map: this.map,
      lastEventTime: this.lastEventTime,
      matchState: this.matchState,
    };
  }
}

function publicEngagement(g: OpenEngagement): Engagement {
  return {
    id: g.id,
    matchKey: g.matchKey,
    map: g.map,
    startedAt: g.startedAt,
    endedAt: g.endedAt,
    startTime: g.startTime,
    endTime: g.endTime,
    kills: g.kills,
    headshots: g.headshots,
    teamkills: g.teamkills,
    avgDistance: g.distanceN ? g.distanceSum / g.distanceN : null,
    factions: g.factions,
    participants: [...g.participants],
    weapons: g.weapons,
  };
}

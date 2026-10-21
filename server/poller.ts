import type { RconClient, RconError, GameStatus, GamePlayer } from './rcon.ts';
import type { Store, MatchPlayerDelta } from './store.ts';
import type { FeedProcessor } from './feed.ts';
import { errorMessage } from './http.ts';
import type { Emit } from './http.ts';

const WATCHED_MS = 2000;
const IDLE_MS = 10_000;
const EMPTY_MS = 30_000;
const HEALTH_EVERY_MS = 30_000;
const CAPS_EVERY_MS = 60 * 60 * 1000;
const MAP_CHANGE_GRACE_MS = 45_000;
const NAME_SETTLE_MS = 60_000;
const RESTART_AFTER_SEC = 24 * 3600;
const WHITELIST_PER_TICK = 3;
const WHITELIST_RETRY_MS = 30_000;
const SCOREBOARD_FLUSH_MS = 30_000;

interface ScoreSeen {
  matchKey: string;
  kills: number;
  deaths: number;
  cash: number | null;
}

interface PollerOptions {
  rcon: RconClient;
  store: Store;
  feed: FeedProcessor;
  emit: Emit;
  watchers: () => number;
}

export class Poller {
  rcon: RconClient;
  store: Store;
  feed: FeedProcessor;
  emit: Emit;
  watchers: () => number;

  status: GameStatus | null = null;
  players: GamePlayer[] = [];
  health: Record<string, any> | null = null;
  serverId: string | null = null;
  version: Awaited<ReturnType<RconClient['version']>> | null = null;
  gameFeed: Awaited<ReturnType<RconClient['feedHealth']>> | null = null;
  online = false;
  lastError: { code: string | undefined; message: string; at: number } | null = null;
  lastPollAt: number | null = null;
  intervalMs = WATCHED_MS;
  mapChangedAt = 0;

  factions = new Map<string, string>();
  joinedAt = new Map<string, number>();
  lastSeenWrite = new Map<string, number>();
  whitelistTried = new Map<string, number>();
  scoreSeen = new Map<string, ScoreSeen>();
  scorePending = new Map<string, MatchPlayerDelta>();
  lastScoreFlush = Date.now();
  lastHealthAt = 0;
  lastCapsAt = 0;
  timer: NodeJS.Timeout | undefined;
  ticking = false;
  stopped = false;

  constructor({ rcon, store, feed, emit, watchers }: PollerOptions) {
    this.rcon = rcon;
    this.store = store;
    this.feed = feed;
    this.emit = emit;
    this.watchers = watchers;
  }

  start() {
    this.stopped = false;
    this.tick();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.flushScoreboard();
  }

  nudge() {
    if (this.intervalMs > WATCHED_MS && !this.ticking) {
      clearTimeout(this.timer);
      this.tick();
    }
  }

  factionOf(steamId: string): string | null {
    return this.factions.get(steamId) ?? null;
  }

  inMapTransition(now = Date.now()) {
    return now - this.mapChangedAt < MAP_CHANGE_GRACE_MS;
  }

  async tick(): Promise<void> {
    const now = Date.now();
    this.ticking = true;
    try {
      if (!this.rcon.capabilities || now - this.lastCapsAt > CAPS_EVERY_MS) {
        await this.rcon.loadCapabilities();
        this.lastCapsAt = now;
        const f = this.rcon.features;
        this.serverId = f.serverId ? await this.rcon.serverId().catch(() => null) : null;
        this.version = f.version ? await this.rcon.version().catch(() => null) : null;
        this.emit('capabilities', this.capabilitiesView());
      }

      const [status, players] = await Promise.all([this.rcon.status(), this.rcon.players()]);
      if (now - this.lastHealthAt > HEALTH_EVERY_MS) {
        const f = this.rcon.features;
        if (f.health) this.health = await this.rcon.health();
        if (f.feed) this.gameFeed = await this.rcon.feedHealth().catch(() => null);
        this.lastHealthAt = now;
      }

      if (this.status && status.map !== this.status.map) {
        this.mapChangedAt = now;
        this.feed.onMapChange(status.map, now);
      } else if (!this.status && status.map) {
        this.feed.onMapChange(status.map, now);
      }

      this.status = status;
      this.ingestPlayers(players, now);
      this.trackScoreboard(now);
      this.online = true;
      this.lastError = null;
      await this.enforcePendingBans();
      await this.enforceWhitelist(now);
    } catch (err) {
      const e = err as RconError;
      this.online = e.status === 429 ? this.online : false;
      this.lastError = { code: e.code, message: e.message, at: now };
    }
    this.ticking = false;
    this.lastPollAt = now;
    this.intervalMs = this.nextInterval();
    if (this.watchers() > 0) this.emit('live', this.snapshot());
    if (!this.stopped) this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  nextInterval(): number {
    if (Date.now() < this.rcon.holdUntil) return Math.max(this.rcon.holdUntil - Date.now(), WATCHED_MS);
    if (!this.online) return EMPTY_MS / 2;
    if (this.watchers() > 0) return this.budgetedInterval(WATCHED_MS);
    return this.players.length === 0 ? EMPTY_MS : IDLE_MS;
  }

  budgetedInterval(target: number): number {
    const limit = this.rcon.capabilities?.limits?.maxRequestsPerMinutePerIp;
    if (!limit) return target;
    const perTick = 2;
    const minMs = Math.ceil((60_000 * perTick) / (limit / 3));
    return Math.max(target, minMs);
  }

  ingestPlayers(list: GamePlayer[], now: number): void {
    const transition = this.inMapTransition(now);
    const present = new Set();
    for (const p of list) {
      if (!p.steamId) continue;
      present.add(p.steamId);
      if (p.faction) this.factions.set(p.steamId, p.faction);
      const isNew = !this.joinedAt.has(p.steamId);
      if (isNew) this.joinedAt.set(p.steamId, now);
      const settled = now - (this.joinedAt.get(p.steamId) ?? now) >= NAME_SETTLE_MS;
      if (isNew || (settled && now - (this.lastSeenWrite.get(p.steamId) ?? 0) > NAME_SETTLE_MS)) {
        this.store.seePlayer(p.steamId, p.name ?? null, now, isNew, settled);
        this.lastSeenWrite.set(p.steamId, now);
      }
    }
    if (!transition) {
      for (const id of this.joinedAt.keys()) {
        if (!present.has(id)) {
          this.joinedAt.delete(id);
          this.factions.delete(id);
          this.lastSeenWrite.delete(id);
          this.whitelistTried.delete(id);
          this.scoreSeen.delete(id);
        }
      }
    }
    this.players = list;
  }

  trackScoreboard(now: number): void {
    const matchKey = this.feed.matchKey;
    if (!matchKey || this.inMapTransition(now)) {
      this.scoreSeen.clear();
    } else {
      const cashOk = !this.cashUnreliable();
      for (const p of this.players) {
        if (!p.steamId) continue;
        const prev = this.scoreSeen.get(p.steamId);
        const cur = { matchKey, kills: p.kills ?? 0, deaths: p.deaths ?? 0, cash: cashOk ? p.cash ?? null : null };
        this.scoreSeen.set(p.steamId, cur);
        const key = `${matchKey} ${p.steamId}`;
        const row = this.scorePending.get(key) ?? {
          matchKey, steamId: p.steamId, map: this.status?.map ?? null, faction: null,
          kills: 0, deaths: 0, cashPeak: null, earned: 0, at: now,
        };
        row.faction = p.faction || this.factionOf(p.steamId) || row.faction;
        row.at = now;
        if (cur.cash != null) row.cashPeak = Math.max(row.cashPeak ?? cur.cash, cur.cash);
        if (prev && prev.matchKey === matchKey) {
          row.kills += cur.kills >= prev.kills ? cur.kills - prev.kills : cur.kills;
          row.deaths += cur.deaths >= prev.deaths ? cur.deaths - prev.deaths : cur.deaths;
          if (cur.cash != null && prev.cash != null && cur.cash > prev.cash) row.earned += cur.cash - prev.cash;
        }
        this.scorePending.set(key, row);
      }
    }
    if (now - this.lastScoreFlush >= SCOREBOARD_FLUSH_MS) this.flushScoreboard(now);
  }

  flushScoreboard(now = Date.now()) {
    this.lastScoreFlush = now;
    if (!this.scorePending.size) return;
    const rows = [...this.scorePending.values()];
    this.scorePending.clear();
    try {
      this.store.addMatchPlayers(rows);
    } catch (err) {
      console.error('scoreboard write failed', err);
    }
  }

  async enforcePendingBans() {
    if (!this.players.length) return;
    const pending = this.store.pendingBans();
    if (!pending.length) return;
    const online = new Map(this.players.map((p) => [p.steamId, p]));
    for (const ban of pending) {
      const player = online.get(ban.steam_id);
      if (!player) continue;
      try {
        await this.rcon.ban(ban.steam_id, ban.reason);
        await this.rcon.kick(ban.steam_id, ban.reason || 'Banned').catch(() => {});
        this.store.removePendingBan(ban.steam_id);
        const entry = this.store.logAction('system', 'pending_ban_enforced', ban.steam_id,
          { name: player.name, reason: ban.reason, queuedBy: ban.created_by }, true);
        this.emit('action', entry);
      } catch (err) {
        await this.rcon.kick(ban.steam_id, ban.reason || 'Banned').catch(() => {});
        this.store.notePendingBanError(ban.steam_id, errorMessage(err));
      }
    }
  }

  async enforceWhitelist(now: number): Promise<void> {
    const { mode, message } = this.store.whitelist();
    let budget = WHITELIST_PER_TICK;

    for (const ban of this.store.whitelistBans()) {
      if (!budget) return;
      if (mode === 'ban' && !ban.linked) continue;
      budget--;
      const why = ban.linked ? 'linked' : 'whitelist_off';
      try {
        await this.rcon.unban(ban.steamId);
        this.store.removeWhitelistBan(ban.steamId);
        this.emit('action', this.store.logAction('system', 'whitelist_unban', ban.steamId, { name: ban.name, why }, true));
      } catch (err) {
        const stillBanned = await this.rcon.bans().then((l) => l.some((b) => b.steamId === ban.steamId), () => true);
        if (stillBanned) this.store.noteWhitelistBanError(ban.steamId, errorMessage(err));
        else this.store.removeWhitelistBan(ban.steamId);
      }
    }

    if (mode === 'off' || !this.players.length) return;
    const linked = this.store.linksBySteam(this.steamIds());
    for (const p of this.players) {
      if (!budget) return;
      if (!p.steamId || linked.has(p.steamId)) continue;
      if (now - (this.whitelistTried.get(p.steamId) ?? 0) < WHITELIST_RETRY_MS) continue;
      this.whitelistTried.set(p.steamId, now);
      budget--;
      const action = mode === 'ban' ? 'whitelist_ban' : 'whitelist_kick';
      try {
        if (mode === 'ban') {
          await this.rcon.ban(p.steamId, message);
          this.store.addWhitelistBan(p.steamId, p.name);
        }
        await this.rcon.kick(p.steamId, message).catch((err) => {
          if (mode !== 'ban') throw err;
        });
        this.emit('action', this.store.logAction('system', action, p.steamId, { name: p.name, reason: message }, true));
      } catch (err) {
        this.emit('action', this.store.logAction('system', action, p.steamId, { name: p.name, reason: message }, false, errorMessage(err)));
      }
    }
  }

  matchView() {
    const s = this.status;
    if (!s) return null;
    const isKoth = (s.experiences || []).some((x) => /KOTH/i.test(x));
    const scoreCap = s.scoreCap ?? (isKoth ? 100 : null);
    return {
      scoreCap,
      scoreCapAssumed: s.scoreCap == null && scoreCap != null,
      matchSeconds: s.matchSeconds ?? this.feed.lastEventTime ?? null,
      matchSecondsSource: s.matchSeconds != null ? 'status' : this.feed.lastEventTime != null ? 'feed' : null,
    };
  }

  playersView() {
    const links = this.store.linksBySteam(this.steamIds());
    return this.players.map((p) => ({
      ...p,
      joinedAt: (p.steamId && this.joinedAt.get(p.steamId)) || null,
      link: (p.steamId && links.get(p.steamId)) || null,
    }));
  }

  steamIds(): string[] {
    return this.players.map((p) => p.steamId).filter((id): id is string => !!id);
  }

  cashUnreliable() {
    return this.players.length >= 4 && this.players.every((p) => !p.cash);
  }

  restartView() {
    const up = this.health?.uptimeSeconds;
    if (up == null) return null;
    return { uptimeSeconds: up, due: up >= RESTART_AFTER_SEC };
  }

  snapshot() {
    const now = Date.now();
    return {
      online: this.online,
      lastError: this.lastError,
      lastPollAt: this.lastPollAt,
      intervalMs: this.intervalMs,
      status: this.status,
      players: this.playersView(),
      health: this.health,
      restart: this.restartView(),
      match: this.matchView(),
      mapTransition: this.inMapTransition(now),
      cashUnreliable: this.cashUnreliable(),
      serverId: this.serverId,
      feed: this.feed.status(),
      gameFeed: this.gameFeed,
      matchStats: this.store.matchStats(this.feed.matchKey),
    };
  }

  capabilitiesView() {
    const c = this.rcon.capabilities;
    if (!c) return null;
    return {
      apiVersion: c.apiVersion, build: c.build, limits: c.limits, config: c.config, routes: c.routes || [],
      features: this.rcon.features, version: this.version,
    };
  }
}

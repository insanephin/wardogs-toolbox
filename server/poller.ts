import type { RconClient, RconError, GameStatus, GamePlayer, GameChat } from './rcon.ts';
import type { ServerStore as Store, MatchPlayerDelta, DiscordLink, Link, NewChatMessage } from './store.ts';
import { CHAT_RETENTION_DAYS } from './store.ts';
import type { FeedProcessor } from './feed.ts';
import { errorMessage } from './http.ts';
import type { Emit } from './http.ts';
import { readSettings } from './settings.ts';
import type { SteamProfiles } from './steam.ts';

const WATCHED_MS = 2000;
const IDLE_MS = 10_000;
const EMPTY_MS = 30_000;
const HEALTH_EVERY_MS = 30_000;
const CAPS_EVERY_MS = 60 * 60 * 1000;
const CONFIG_EVERY_MS = 60_000;
const MAP_CHANGE_GRACE_MS = 45_000;
const NAME_SETTLE_MS = 60_000;
const RESTART_AFTER_SEC = 24 * 3600;
const WHITELIST_PER_TICK = 3;
const WHITELIST_RETRY_MS = 30_000;
const TURNOVER_BLOCK_MS = 30_000;
const TURNOVER_RETRY_MS = 5_000;
const TURNOVER_REJOIN_MS = 15_000;
const MANUAL_MAP_WINDOW_MS = 5 * 60_000;
const SCOREBOARD_FLUSH_MS = 30_000;
export const CASH_SAMPLE_MS = 60_000;
const CASH_MAX_POINTS = 360;
const CHAT_PAGE = 200;
const CHAT_PAGES = 5;
const CHAT_PRUNE_MS = 3600_000;

type ChatState = 'unsupported' | 'terms' | 'ok' | 'error';

interface CashPoint {
  t: number;
  total: number;
  factions: Record<string, number>;
}

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
  steam?: SteamProfiles;
  onServerId?: (id: string) => void;
  onServerName?: (name: string) => void;
}

export class Poller {
  rcon: RconClient;
  store: Store;
  feed: FeedProcessor;
  emit: Emit;
  watchers: () => number;
  steam: SteamProfiles | undefined;

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
  gateTried = new Map<string, number>();
  turnoverPending = new Set<string>();
  turnoverBlocked = new Map<string, number>();
  turnoverNextTry = new Map<string, number>();
  manualMapUntil = 0;
  scoreSeen = new Map<string, ScoreSeen>();
  scorePending = new Map<string, MatchPlayerDelta>();
  lastScoreFlush = Date.now();
  cash: { matchKey: string | null; points: CashPoint[] } = { matchKey: null, points: [] };
  lastCashAt = 0;
  lastMatchSeconds: number | null = null;
  lastHealthAt = 0;
  rotation: Record<string, any> | null = null;
  rotationStale = true;
  lastCapsAt = 0;
  passworded: boolean | null = null;
  lastConfigAt = 0;
  chatSeq = 0;
  chat: { state: ChatState; error: string | null; lastAt: number | null } = { state: 'unsupported', error: null, lastAt: null };
  lastChatPruneAt = 0;
  timer: NodeJS.Timeout | undefined;
  ticking = false;
  stopped = false;

  onServerId: (id: string) => void;
  onServerName: (name: string) => void;

  constructor({ rcon, store, feed, emit, watchers, steam, onServerId = () => {}, onServerName = () => {} }: PollerOptions) {
    this.onServerId = onServerId;
    this.onServerName = onServerName;
    this.steam = steam;
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

  recheckConfig() {
    this.lastConfigAt = 0;
  }

  recheckHealth() {
    this.lastHealthAt = 0;
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
        [this.serverId, this.version] = await Promise.all([
          f.serverId ? this.rcon.serverId().catch(() => null) : null,
          f.version ? this.rcon.version().catch(() => null) : null,
        ]);
        if (this.serverId) this.onServerId(this.serverId);
        this.emit('capabilities', this.capabilitiesView());
      }

      const [status, players] = await Promise.all([this.rcon.status(), this.rcon.players()]);
      if (now - this.lastHealthAt > HEALTH_EVERY_MS) {
        const f = this.rcon.features;
        const [health, gameFeed] = await Promise.all([
          f.health ? this.rcon.health().catch(() => null) : this.health,
          f.feed ? this.rcon.feedHealth().catch(() => null) : this.gameFeed,
        ]);
        this.health = health;
        this.gameFeed = gameFeed;
        this.lastHealthAt = now;
        this.rotationStale = true;
      }

      if (this.status && status.map !== this.status.map) {
        this.mapChangedAt = now;
        this.rotationStale = true;
        this.feed.onMapChange(status.map, now);
      } else if (!this.status && status.map) {
        this.feed.onMapChange(status.map, now);
      }

      this.status = status;
      if (status.serverName) this.onServerName(status.serverName);
      if (now - this.lastConfigAt > CONFIG_EVERY_MS) {
        this.passworded = await this.rcon.config().then((d) => !!String(readSettings(d.text).serverPassword ?? '').trim(), () => this.passworded);
        this.lastConfigAt = now;
      }
      if (this.rotationStale && this.rcon.features.rotation) {
        this.rotation = await this.rcon.rotation().catch(() => this.rotation);
        this.rotationStale = false;
      }
      this.ingestPlayers(players, now);
      await this.pollChat(now);
      this.steam?.warm(this.steamIds());
      this.trackScoreboard(now);
      this.sampleCash(now);
      this.online = true;
      this.lastError = null;
      const streamers = this.streamersOnline();
      await this.enforcePendingBans();
      await this.enforceTurnover(now, streamers);
      await this.enforceEntryGate(now, streamers);
      await this.enforceWhitelist(now, streamers);
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
    if (this.turnoverActive() || this.watchers() > 0) return this.budgetedInterval(WATCHED_MS);
    return this.players.length === 0 ? EMPTY_MS : IDLE_MS;
  }

  budgetedInterval(target: number): number {
    const limit = this.rcon.capabilities?.limits?.maxRequestsPerMinutePerIp;
    if (!limit) return target;
    const perTick = this.rcon.features.chat ? 3 : 2;
    const minMs = Math.ceil((60_000 * perTick) / (limit / 3));
    return Math.max(target, minMs);
  }

  async pollChat(now: number): Promise<void> {
    if (!this.rcon.features.chat) {
      this.chat = { state: 'unsupported', error: null, lastAt: this.chat.lastAt };
      return;
    }
    const rows: NewChatMessage[] = [];
    try {
      for (let page = 0; page < CHAT_PAGES; page++) {
        const r = await this.rcon.chat(this.chatSeq, CHAT_PAGE);
        if (r.latestSeq != null && r.latestSeq < this.chatSeq) {
          this.chatSeq = 0;
          continue;
        }
        for (const m of r.messages) {
          const seq = Number(m.seq);
          if (!Number.isFinite(seq) || seq <= this.chatSeq) continue;
          this.chatSeq = seq;
          rows.push(this.chatRow(m, seq, now));
        }
        if (!r.messages.length && r.latestSeq != null) this.chatSeq = Math.max(this.chatSeq, r.latestSeq);
        if (r.messages.length < CHAT_PAGE) break;
      }
      this.chat = { state: 'ok', error: null, lastAt: now };
    } catch (err) {
      const e = err as RconError;
      this.chat = e.code === 'chat_terms_not_accepted'
        ? { state: 'terms', error: null, lastAt: this.chat.lastAt }
        : { state: 'error', error: e.message, lastAt: this.chat.lastAt };
    }
    if (rows.length) {
      const added = this.store.insertChat(rows);
      if (added.length) this.emit('chat', { latestId: added.at(-1)!.id, count: added.length });
    }
    if (now - this.lastChatPruneAt > CHAT_PRUNE_MS) {
      this.lastChatPruneAt = now;
      const removed = this.store.pruneChat(now - CHAT_RETENTION_DAYS * 86400_000);
      if (removed) console.log(`[채팅] 보관 기간이 지난 채팅 ${removed}건을 지웠습니다`);
    }
  }

  chatRow(m: GameChat, seq: number, now: number): NewChatMessage {
    const sent = Date.parse(m.sentUtc ?? '');
    const str = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);
    return {
      seq,
      sentAt: Number.isFinite(sent) ? sent : now,
      receivedAt: now,
      matchKey: this.feed.matchKey,
      map: this.status?.map ?? null,
      channel: str(m.channel, 32),
      faction: str(m.faction, 32),
      steamId: str(m.steamId, 32),
      realName: str(m.realName, 128),
      hiddenName: str(m.hiddenName, 128),
      anonymous: !!m.anonymous,
      text: str(m.text, 1000) ?? str(m.rawText, 1000) ?? '',
      rawText: str(m.rawText, 1000),
      ping: !!m.ping,
    };
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
          this.gateTried.delete(id);
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

  sampleCash(now: number): void {
    const matchKey = this.feed.matchKey;
    const seconds = this.status?.matchSeconds ?? null;
    const restarted = seconds != null && this.lastMatchSeconds != null && seconds < this.lastMatchSeconds - 5;
    this.lastMatchSeconds = seconds;
    if (matchKey !== this.cash.matchKey || restarted) {
      this.cash = { matchKey, points: [] };
      this.lastCashAt = 0;
    }
    if (!matchKey || !this.players.length || this.inMapTransition(now) || this.cashUnreliable()) return;
    if (now - this.lastCashAt < CASH_SAMPLE_MS) return;
    this.lastCashAt = now;
    const point: CashPoint = { t: now, total: 0, factions: {} };
    for (const p of this.players) {
      const cash = Number(p.cash) || 0;
      point.total += cash;
      if (p.faction) point.factions[p.faction] = (point.factions[p.faction] ?? 0) + cash;
    }
    this.cash.points.push(point);
    if (this.cash.points.length > CASH_MAX_POINTS) this.cash.points.splice(0, this.cash.points.length - CASH_MAX_POINTS);
    this.emit('cash', { matchKey, point });
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

  async enforceEntryGate(now: number, streamers: Map<string, DiscordLink>): Promise<void> {
    const gate = this.store.entryGate();
    if (!gate.active) return;
    const online = this.players.filter((p) => p.steamId && streamers.has(p.steamId)).length;
    const why = online >= gate.threshold ? 'threshold' : gate.openAt && now >= gate.openAt ? 'timeout' : null;
    if (why) {
      this.store.setEntryGate({ ...gate, active: false, startedAt: null, openAt: null });
      this.emit('action', this.store.logAction('system', 'entry_gate_open', null, { why, streamers: online, threshold: gate.threshold }, true));
      return;
    }
    if (this.inMapTransition(now)) return;
    let budget = WHITELIST_PER_TICK;
    for (const p of this.players) {
      if (!budget) return;
      if (!p.steamId || streamers.has(p.steamId)) continue;
      if (now - (this.gateTried.get(p.steamId) ?? 0) < WHITELIST_RETRY_MS) continue;
      this.gateTried.set(p.steamId, now);
      budget--;
      try {
        await this.rcon.kick(p.steamId, gate.message);
        this.emit('action', this.store.logAction('system', 'entry_gate_kick', p.steamId, { name: p.name, reason: gate.message }, true));
      } catch (err) {
        this.emit('action', this.store.logAction('system', 'entry_gate_kick', p.steamId, { name: p.name, reason: gate.message }, false, errorMessage(err)));
      }
    }
  }

  onMatchEnd(): void {
    const now = Date.now();
    const enabled = this.store.turnover().enabled;
    if (now < this.manualMapUntil) {
      this.manualMapUntil = 0;
      if (enabled) this.emit('action', this.store.logAction('system', 'turnover_skip', this.feed.map, { why: 'manual' }, true));
      return;
    }
    if (!enabled) return;
    this.startTurnover(now);
    if (!this.ticking) {
      clearTimeout(this.timer);
      this.tick();
    }
  }

  startTurnover(now: number): void {
    const ids = new Set(this.steamIds());
    const streamers = this.store.discordLinksBySteam([...ids]);
    for (const id of ids) {
      if (streamers.has(id)) continue;
      this.turnoverPending.add(id);
      this.turnoverBlocked.set(id, now + TURNOVER_BLOCK_MS);
    }
    this.emit('action', this.store.logAction('system', 'turnover_start', null, { players: this.turnoverPending.size }, true));
  }

  expectManualMapChange() {
    this.manualMapUntil = Date.now() + MANUAL_MAP_WINDOW_MS;
  }

  cancelManualMapChange() {
    this.manualMapUntil = 0;
  }

  turnoverActive() {
    return this.turnoverPending.size > 0 || this.turnoverBlocked.size > 0;
  }

  kickBudget(): number {
    const limit = this.rcon.capabilities?.limits?.maxRequestsPerMinutePerIp;
    return limit ? Math.max(WHITELIST_PER_TICK, Math.floor((limit * 2) / 3) - 5) : Infinity;
  }

  async enforceTurnover(now: number, streamers: Map<string, DiscordLink>): Promise<void> {
    const { enabled, message } = this.store.turnover();
    if (!enabled) {
      this.turnoverPending.clear();
      this.turnoverBlocked.clear();
    }
    for (const [id, until] of this.turnoverBlocked) if (until <= now) this.turnoverBlocked.delete(id);
    if (!this.inMapTransition(now)) {
      const present = new Set(this.steamIds());
      for (const id of this.turnoverPending) if (!present.has(id)) this.turnoverPending.delete(id);
    }
    if (!this.turnoverActive()) {
      this.turnoverNextTry.clear();
      return;
    }
    const targets = this.players.filter((p): p is GamePlayer & { steamId: string } => !!p.steamId
      && !streamers.has(p.steamId)
      && (this.turnoverPending.has(p.steamId) || (this.turnoverBlocked.get(p.steamId) ?? 0) > now)
      && now >= (this.turnoverNextTry.get(p.steamId) ?? 0)).slice(0, this.kickBudget());
    const results = await Promise.allSettled(targets.map((p) => this.rcon.kick(p.steamId, message)));
    results.forEach((r, i) => {
      const p = targets[i];
      const retry = this.turnoverNextTry.has(p.steamId);
      this.turnoverNextTry.set(p.steamId, now + (r.status === 'fulfilled' ? TURNOVER_REJOIN_MS : TURNOVER_RETRY_MS));
      if (r.status === 'fulfilled') {
        if (this.turnoverPending.delete(p.steamId)) {
          this.turnoverBlocked.set(p.steamId, Math.max(this.turnoverBlocked.get(p.steamId) ?? 0, now + TURNOVER_BLOCK_MS));
        }
        this.emit('action', this.store.logAction('system', 'turnover_kick', p.steamId, { name: p.name, reason: message }, true));
      } else if (!retry) {
        this.emit('action', this.store.logAction('system', 'turnover_kick', p.steamId, { name: p.name, reason: message }, false, errorMessage(r.reason)));
      }
    });
  }

  turnoverView() {
    const now = Date.now();
    const until = Math.max(0, ...this.turnoverBlocked.values());
    return {
      ...this.store.turnover(),
      pending: this.turnoverPending.size,
      blocked: [...this.turnoverBlocked.values()].filter((t) => t > now).length,
      blockedUntil: until > now ? until : null,
    };
  }

  entryGateView(streamers = this.streamersOnline()) {
    const gate = this.store.entryGate();
    return { ...gate, streamersOnline: this.players.filter((p) => p.steamId && streamers.has(p.steamId)).length };
  }

  async enforceWhitelist(now: number, streamers: Map<string, DiscordLink>): Promise<void> {
    const { mode, message } = this.store.whitelist();
    let budget = WHITELIST_PER_TICK;

    for (const ban of this.store.whitelistBans()) {
      if (!budget) return;
      if (!ban.linked) continue;
      budget--;
      try {
        await this.rcon.unban(ban.steamId);
        this.store.removeWhitelistBan(ban.steamId);
        this.emit('action', this.store.logAction('system', 'whitelist_unban', ban.steamId, { name: ban.name, why: 'linked' }, true));
      } catch (err) {
        const stillBanned = await this.rcon.bans().then((l) => l.some((b) => b.steamId === ban.steamId), () => true);
        if (stillBanned) this.store.noteWhitelistBanError(ban.steamId, errorMessage(err));
        else this.store.removeWhitelistBan(ban.steamId);
      }
    }

    if (mode === 'off' || !this.players.length) return;
    const linked = this.passingLinks(this.steamIds());
    for (const p of this.players) {
      if (!budget) return;
      if (!p.steamId || linked.has(p.steamId) || streamers.has(p.steamId)) continue;
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

  refreshRotation() {
    this.rotationStale = true;
    this.nudge();
  }

  nextMapView() {
    const r = this.rotation;
    if (!r || r.enabled === false) return null;
    const e = (r.entries || []).find((x: Record<string, any>) => x.status === 'next');
    return e ? { map: e.map, lighting: e.lighting ?? null, experiences: e.experiences ?? [] } : null;
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

  passingLinks(steamIds: string[]): Map<string, Link> {
    const links = this.store.linksBySteam(steamIds);
    const { audience } = this.store.whitelist();
    if (audience === 'linked') return links;
    const inAudience = this.store.audienceOf(audience, [...links.values()].map((l) => l.chzzkChannelId));
    for (const [id, l] of links) if (!inAudience.has(l.chzzkChannelId)) links.delete(id);
    return links;
  }

  playersView(streamers: Map<string, DiscordLink>) {
    const links = this.store.linksBySteam(this.steamIds());
    const channels = [...links.values()].map((l) => l.chzzkChannelId);
    const subscribed = this.store.audienceOf('subscriber', channels);
    const followed = this.store.audienceOf('follower', channels);
    const channelOf = (p: GamePlayer) => (p.steamId && links.get(p.steamId)?.chzzkChannelId) || '';
    return this.players.map((p) => ({
      ...p,
      joinedAt: (p.steamId && this.joinedAt.get(p.steamId)) || null,
      link: (p.steamId && links.get(p.steamId)) || null,
      subscriber: subscribed.has(channelOf(p)),
      follower: followed.has(channelOf(p)),
      streamer: (p.steamId && streamers.get(p.steamId)) || null,
      avatar: (p.steamId && this.steam?.cached(p.steamId)?.avatar) || null,
    }));
  }

  streamersOnline(): Map<string, DiscordLink> {
    return this.store.discordLinksBySteam(this.steamIds());
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
    const streamers = this.streamersOnline();
    return {
      online: this.online,
      lastError: this.lastError,
      lastPollAt: this.lastPollAt,
      intervalMs: this.intervalMs,
      status: this.status,
      players: this.playersView(streamers),
      health: this.health,
      chat: this.chat,
      restart: this.restartView(),
      match: this.matchView(),
      mapTransition: this.inMapTransition(now),
      cashUnreliable: this.cashUnreliable(),
      serverId: this.serverId,
      feed: this.feed.status(),
      gameFeed: this.gameFeed,
      matchStats: this.store.matchStats(this.feed.matchKey),
      nextMap: this.nextMapView(),
      rotationEnabled: this.rotation ? this.rotation.enabled !== false : null,
      entryGate: this.entryGateView(streamers),
      turnover: this.turnoverView(),
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

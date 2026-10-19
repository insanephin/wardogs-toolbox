// SQLite persistence. The feed never resends, so everything received is written immediately.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kills (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  match_key TEXT,
  map TEXT,
  event_time REAL,
  killer_steam TEXT, killer_name TEXT, killer_faction TEXT,
  victim_steam TEXT, victim_name TEXT, victim_faction TEXT,
  cause TEXT, weapon TEXT,
  distance_m REAL,
  tags TEXT NOT NULL DEFAULT '[]',
  headshot INTEGER NOT NULL DEFAULT 0,
  suicide INTEGER NOT NULL DEFAULT 0,
  teamkill INTEGER NOT NULL DEFAULT 0,
  engagement_id INTEGER
);
CREATE INDEX IF NOT EXISTS kills_received ON kills(received_at);
CREATE INDEX IF NOT EXISTS kills_killer ON kills(killer_steam);
CREATE INDEX IF NOT EXISTS kills_victim ON kills(victim_steam);
CREATE INDEX IF NOT EXISTS kills_match ON kills(match_key);

CREATE TABLE IF NOT EXISTS match_events (
  event_id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  map TEXT,
  event_time REAL,
  match_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS match_events_received ON match_events(received_at);

CREATE TABLE IF NOT EXISTS engagements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_key TEXT,
  map TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  start_time REAL,
  end_time REAL,
  kills INTEGER NOT NULL DEFAULT 0,
  headshots INTEGER NOT NULL DEFAULT 0,
  teamkills INTEGER NOT NULL DEFAULT 0,
  distance_sum REAL NOT NULL DEFAULT 0,
  distance_n INTEGER NOT NULL DEFAULT 0,
  factions TEXT NOT NULL DEFAULT '{}',
  participants TEXT NOT NULL DEFAULT '[]',
  weapons TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS engagements_started ON engagements(started_at);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS actions_at ON actions(at);

CREATE TABLE IF NOT EXISTS players (
  steam_id TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_name TEXT,
  sessions INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS player_names (
  steam_id TEXT NOT NULL,
  name TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (steam_id, name)
);

CREATE TABLE IF NOT EXISTS pending_bans (
  steam_id TEXT PRIMARY KEY,
  reason TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  last_error TEXT
);

-- Written by the Discord bot (bot/utils/database/sqlite/models.py); created here too so the
-- dashboard works before the bot has ever run. Keep the two definitions in step.
CREATE TABLE IF NOT EXISTS account_links (
  discord_id BIGINT NOT NULL,
  discord_name VARCHAR,
  steam_id VARCHAR,
  steam_name VARCHAR,
  steam_linked_at DATETIME,
  chzzk_channel_id VARCHAR,
  chzzk_name VARCHAR,
  chzzk_linked_at DATETIME,
  PRIMARY KEY (discord_id),
  UNIQUE (steam_id),
  UNIQUE (chzzk_channel_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The in-game scoreboard (kills, deaths, cash) per match, accumulated from polls. Feeds the public
-- leaderboard. faction is the last one seen, so a team switch counts for the side the player ended on.
CREATE TABLE IF NOT EXISTS match_players (
  match_key TEXT NOT NULL,
  steam_id TEXT NOT NULL,
  map TEXT,
  faction TEXT,
  kills INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  cash_peak INTEGER,
  cash_earned INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (match_key, steam_id)
);
CREATE INDEX IF NOT EXISTS match_players_seen ON match_players(last_seen);

CREATE TABLE IF NOT EXISTS match_results (
  match_key TEXT PRIMARY KEY,
  winning_faction TEXT,
  ended_at INTEGER NOT NULL
);

-- One row per POST to the ingest endpoint, accepted or not. Pruned to FEED_REQUEST_KEEP rows.
CREATE TABLE IF NOT EXISTS feed_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  peer TEXT,
  status INTEGER NOT NULL,
  code TEXT,
  events INTEGER,
  accepted INTEGER,
  duplicates INTEGER,
  error TEXT
);

-- Bans placed by the whitelist, kept apart from moderator bans so lifting them never touches those.
CREATE TABLE IF NOT EXISTS whitelist_bans (
  steam_id TEXT PRIMARY KEY,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_error TEXT
);
`;

// Discord IDs pass 2^53, which node:sqlite refuses to read as a number; always select them as text.
// Queries alias account_links as `a`.
const LINK_COLUMNS = `CAST(a.discord_id AS TEXT) AS discordId, a.discord_name AS discordName,
  a.steam_id AS steamId, a.steam_name AS steamName, a.steam_linked_at AS steamLinkedAt,
  a.chzzk_channel_id AS chzzkChannelId, a.chzzk_name AS chzzkName, a.chzzk_linked_at AS chzzkLinkedAt`;

const FEED_REQUEST_KEEP = 5000;

export const WHITELIST_MODES = ['off', 'kick', 'ban'] as const;
export type WhitelistMode = (typeof WHITELIST_MODES)[number];
export interface Whitelist {
  mode: WhitelistMode;
  message: string;
}
const WHITELIST_DEFAULT: Whitelist = { mode: 'off', message: '화이트리스트에 등록되지 않은 유저입니다.' };

// node:sqlite types every column as a generic SQL value; rows are mapped to the shapes below.
type Row = Record<string, any>;

export interface Kill {
  eventId: string;
  receivedAt: number;
  matchKey: string | null;
  map: string | null;
  eventTime: number | null;
  killerSteamId: string | null;
  killerName: string | null;
  killerFaction: string | null;
  victimSteamId: string | null;
  victimName: string | null;
  victimFaction: string | null;
  cause: string | null;
  weapon: string | null;
  distanceM: number | null;
  tags: string[];
  headshot: boolean;
  suicide: boolean;
  teamkill: boolean;
  engagementId: number | null;
}

export interface Engagement {
  id: number;
  matchKey: string | null;
  map: string | null;
  startedAt: number;
  endedAt: number;
  startTime: number | null;
  endTime: number | null;
  kills: number;
  headshots: number;
  teamkills: number;
  avgDistance: number | null;
  factions: Record<string, number>;
  participants: string[];
  weapons: Record<string, number>;
}

// The engagement still being added to, as feed.ts keeps it in memory.
export interface OpenEngagement extends Omit<Engagement, 'avgDistance' | 'participants'> {
  distanceSum: number;
  distanceN: number;
  participants: Set<string>;
}

export interface MatchEvent {
  eventId: string;
  type: string;
  mapName?: string;
  eventTime?: number;
  matchId?: string;
  [key: string]: unknown;
}

export interface MatchPlayerDelta {
  matchKey: string;
  steamId: string;
  map: string | null;
  faction: string | null;
  kills: number;
  deaths: number;
  cashPeak: number | null;
  earned: number;
  at: number;
}

interface MatchPlayerSeen {
  matchKey: string;
  map: string | null;
  lastSeen: number;
}

export interface Action {
  at: number;
  actor: string;
  action: string;
  target: string | null | undefined;
  detail: unknown;
  ok: boolean;
  error?: string | null;
}

export interface FeedRequest {
  at: number;
  peer?: string | null;
  status: number;
  code?: string | null;
  events?: number | null;
  accepted?: number | null;
  duplicates?: number | null;
  error?: string | null;
}

export interface Link {
  discordId: string;
  discordName: string | null;
  steamId: string | null;
  steamName: string | null;
  steamLinkedAt: number | null;
  chzzkChannelId: string | null;
  chzzkName: string | null;
  chzzkLinkedAt: number | null;
}

export type LinkWithSeen = Link & { lastName: string | null; lastSeen: number | null };

export interface PendingBan {
  steam_id: string;
  reason: string | null;
  created_at: number;
  created_by: string;
  last_error: string | null;
}

export interface WhitelistBan {
  steamId: string;
  name: string | null;
  createdAt: number;
  lastError: string | null;
  linked: boolean;
}

export interface LeaderboardRow {
  channelId: string;
  name: string;
  matches: number;
  kills: number;
  deaths: number;
  cashEarned: number;
  cashPeak: number | null;
  wins: number;
  decided: number;
  lastSeen: number;
  feedKills: number;
  headshots: number;
  longest: number | null;
}

export class Store {
  db: DatabaseSync;
  q: ReturnType<typeof prepareQueries>;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    // account_links predates discord_name when the bot created it first.
    const cols = (this.db.prepare('PRAGMA table_info(account_links)').all() as Row[]).map((c) => c.name);
    if (!cols.includes('discord_name')) this.db.exec('ALTER TABLE account_links ADD COLUMN discord_name VARCHAR');
    this.q = prepareQueries(this.db);
  }

  hasKill(eventId: string): boolean {
    return !!this.q.hasKill.get(eventId);
  }

  lastKill(): Kill | null {
    const r = this.db.prepare('SELECT * FROM kills ORDER BY received_at DESC LIMIT 1').get();
    return r ? rowToKill(r) : null;
  }

  lastMatchPlayer(): MatchPlayerSeen | null {
    return (this.db.prepare(`SELECT match_key AS matchKey, map, last_seen AS lastSeen
      FROM match_players ORDER BY last_seen DESC LIMIT 1`).get() as Row | undefined) as MatchPlayerSeen | undefined ?? null;
  }

  insertKill(k: Kill): boolean {
    const r = this.q.insertKill.run({
      ...k,
      tags: JSON.stringify(k.tags),
      headshot: k.headshot ? 1 : 0,
      suicide: k.suicide ? 1 : 0,
      teamkill: k.teamkill ? 1 : 0,
    });
    return r.changes > 0;
  }

  insertMatchEvent(e: MatchEvent, receivedAt: number): boolean {
    const r = this.q.insertMatchEvent.run(
      e.eventId, receivedAt, e.type, e.mapName ?? null, e.eventTime ?? null, e.matchId ?? null, JSON.stringify(e),
    );
    return r.changes > 0;
  }

  createEngagement(matchKey: string | null, map: string | null, at: number, eventTime: number | null): number {
    return Number(this.q.insertEngagement.run(matchKey, map, at, at, eventTime, eventTime).lastInsertRowid);
  }

  saveEngagement(e: OpenEngagement): void {
    this.q.updateEngagement.run({
      id: e.id,
      endedAt: e.endedAt,
      endTime: e.endTime,
      kills: e.kills,
      headshots: e.headshots,
      teamkills: e.teamkills,
      distanceSum: e.distanceSum,
      distanceN: e.distanceN,
      factions: JSON.stringify(e.factions),
      participants: JSON.stringify([...e.participants]),
      weapons: JSON.stringify(e.weapons),
    });
  }

  logAction(actor: string, action: string, target: string | null | undefined, detail: unknown, ok: boolean, error?: string | null): Action {
    const at = Date.now();
    this.q.insertAction.run(at, actor, action, target ?? null, detail ? JSON.stringify(detail) : null, ok ? 1 : 0, error ?? null);
    return { at, actor, action, target, detail, ok, error };
  }

  seePlayer(steamId: string, name: string | null, now: number, newSession: boolean, recordName: boolean): void {
    this.q.upsertPlayer.run(steamId, now, now, name, newSession ? 1 : 0);
    if (recordName && name != null) this.q.upsertName.run(steamId, name, now, now);
  }

  addMatchPlayers(rows: MatchPlayerDelta[]): void {
    if (!rows.length) return;
    this.db.exec('BEGIN');
    try {
      for (const r of rows) this.q.addMatchPlayer.run({ ...r });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  setMatchResult(matchKey: string, winningFaction: string | null | undefined, at: number): void {
    this.db.prepare(`INSERT INTO match_results (match_key, winning_faction, ended_at) VALUES (?, ?, ?)
      ON CONFLICT(match_key) DO UPDATE SET winning_faction = excluded.winning_faction, ended_at = excluded.ended_at`)
      .run(matchKey, winningFaction || null, at);
  }

  // Public leaderboard: Chzzk-linked players only, and nothing that identifies them beyond their
  // channel (no SteamID or Discord ID). Headshots come from the kill feed, the rest from polling.
  leaderboard(since = 0): LeaderboardRow[] {
    return this.db.prepare(`
      WITH mp AS (
        SELECT m.steam_id, COUNT(*) AS matches, SUM(m.kills) AS kills, SUM(m.deaths) AS deaths,
          SUM(m.cash_earned) AS cashEarned, MAX(m.cash_peak) AS cashPeak,
          SUM(CASE WHEN r.winning_faction IS NOT NULL AND m.faction = r.winning_faction THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN r.match_key IS NOT NULL THEN 1 ELSE 0 END) AS decided,
          MAX(m.last_seen) AS lastSeen
        FROM match_players m LEFT JOIN match_results r ON r.match_key = m.match_key
        WHERE m.last_seen >= :since GROUP BY m.steam_id
      ), k AS (
        SELECT killer_steam AS steam_id, COUNT(*) AS feedKills, SUM(headshot) AS headshots, MAX(distance_m) AS longest
        FROM kills WHERE received_at >= :since AND suicide = 0 AND teamkill = 0 AND killer_steam IS NOT NULL
        GROUP BY killer_steam
      )
      SELECT a.chzzk_channel_id AS channelId, a.chzzk_name AS name,
        mp.matches, mp.kills, mp.deaths, mp.cashEarned, mp.cashPeak, mp.wins, mp.decided, mp.lastSeen,
        COALESCE(k.feedKills, 0) AS feedKills, COALESCE(k.headshots, 0) AS headshots, k.longest
      FROM mp JOIN account_links a ON a.steam_id = mp.steam_id AND a.chzzk_channel_id IS NOT NULL
      LEFT JOIN k ON k.steam_id = mp.steam_id`).all({ since }) as Row[] as LeaderboardRow[];
  }

  recentKills({ limit = 100, before, search }: { limit?: number; before?: number; search?: string } = {}): Kill[] {
    const where: string[] = [];
    const args: Record<string, string | number> = {};
    if (before) { where.push('received_at < :before'); args.before = before; }
    if (search) {
      where.push('(killer_name LIKE :s OR victim_name LIKE :s OR weapon LIKE :s OR cause LIKE :s OR killer_steam = :raw OR victim_steam = :raw)');
      args.s = `%${search}%`;
      args.raw = search;
    }
    args.limit = Math.min(limit, 500);
    const sql = `SELECT * FROM kills ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY received_at DESC, event_time DESC LIMIT :limit`;
    return this.db.prepare(sql).all(args).map(rowToKill);
  }

  recentEngagements({ limit = 30, minKills = 1 } = {}): Engagement[] {
    return this.db.prepare('SELECT * FROM engagements WHERE kills >= ? ORDER BY started_at DESC LIMIT ?')
      .all(minKills, limit).map(rowToEngagement);
  }

  engagementKills(id: number): Kill[] {
    return this.db.prepare('SELECT * FROM kills WHERE engagement_id = ? ORDER BY received_at, event_time').all(id).map(rowToKill);
  }

  matchStats(matchKey: string | null) {
    if (!matchKey) return [];
    return this.q.matchStats.all(matchKey);
  }

  weaponStats({ since = 0, limit = 30 } = {}) {
    return this.db.prepare(`
      SELECT weapon, COUNT(*) AS kills, SUM(headshot) AS headshots, AVG(distance_m) AS avgDistance, MAX(distance_m) AS maxDistance
      FROM kills WHERE received_at >= ? AND weapon IS NOT NULL AND suicide = 0
      GROUP BY weapon ORDER BY kills DESC LIMIT ?`).all(since, limit);
  }

  recentMatchEvents(limit = 50): (MatchEvent & { receivedAt: number })[] {
    return (this.db.prepare('SELECT * FROM match_events ORDER BY received_at DESC LIMIT ?').all(limit) as Row[])
      .map((r) => ({ ...JSON.parse(r.payload), receivedAt: r.received_at }));
  }

  logFeedRequest(r: FeedRequest): void {
    const id = Number(this.q.insertFeedRequest.run({
      at: r.at, peer: r.peer ?? null, status: r.status, code: r.code ?? null, events: r.events ?? null,
      accepted: r.accepted ?? null, duplicates: r.duplicates ?? null, error: r.error ? String(r.error).slice(0, 200) : null,
    }).lastInsertRowid);
    // Cheap on the primary key, and keeps a flood of bad requests from growing the file.
    this.q.pruneFeedRequests.run(id - FEED_REQUEST_KEEP);
  }

  feedRequests(limit = 300) {
    return this.db.prepare('SELECT * FROM feed_requests ORDER BY id DESC LIMIT ?').all(limit);
  }

  // Kills and other feed events, newest first, as one list. Kills carry type 'killed'.
  feedEvents(limit = 300) {
    const kills = this.recentKills({ limit }).map((k) => ({ type: 'killed', ...k }));
    return [...kills, ...this.recentMatchEvents(limit)].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, limit);
  }

  actions({ limit = 200 } = {}): Action[] {
    return (this.db.prepare('SELECT * FROM actions ORDER BY at DESC LIMIT ?').all(limit) as Row[])
      .map((r) => ({ ...r, ok: !!r.ok, detail: r.detail ? JSON.parse(r.detail) : null }) as Action);
  }

  playerProfile(steamId: string) {
    const p = this.db.prepare('SELECT * FROM players WHERE steam_id = ?').get(steamId);
    const names = this.db.prepare('SELECT name, first_seen, last_seen FROM player_names WHERE steam_id = ? ORDER BY last_seen DESC').all(steamId);
    const totals = this.db.prepare(`SELECT
        SUM(CASE WHEN killer_steam = :s AND suicide = 0 THEN 1 ELSE 0 END) AS kills,
        SUM(CASE WHEN victim_steam = :s THEN 1 ELSE 0 END) AS deaths,
        SUM(CASE WHEN killer_steam = :s AND headshot = 1 AND suicide = 0 THEN 1 ELSE 0 END) AS headshots,
        SUM(CASE WHEN killer_steam = :s AND teamkill = 1 THEN 1 ELSE 0 END) AS teamkills
      FROM kills WHERE killer_steam = :s OR victim_steam = :s`).get({ s: steamId });
    const weapons = this.db.prepare(`SELECT weapon, COUNT(*) AS kills FROM kills
      WHERE killer_steam = ? AND suicide = 0 GROUP BY weapon ORDER BY kills DESC LIMIT 8`).all(steamId);
    return { player: p ?? null, names, totals, weapons };
  }

  pendingBans(): PendingBan[] {
    return this.q.pendingBans.all() as Row[] as PendingBan[];
  }

  addPendingBan(steamId: string, reason: string | null, by: string): void {
    this.db.prepare(`INSERT INTO pending_bans (steam_id, reason, created_at, created_by) VALUES (?, ?, ?, ?)
      ON CONFLICT(steam_id) DO UPDATE SET reason = excluded.reason`).run(steamId, reason ?? null, Date.now(), by);
  }

  removePendingBan(steamId: string): boolean {
    return this.db.prepare('DELETE FROM pending_bans WHERE steam_id = ?').run(steamId).changes > 0;
  }

  notePendingBanError(steamId: string, error: string): void {
    this.db.prepare('UPDATE pending_bans SET last_error = ? WHERE steam_id = ?').run(error, steamId);
  }

  // Every link, with the name the server last saw for the Steam account.
  links(): LinkWithSeen[] {
    return (this.db.prepare(`SELECT ${LINK_COLUMNS}, p.last_name AS lastName, p.last_seen AS lastSeen
      FROM account_links a LEFT JOIN players p ON p.steam_id = a.steam_id
      ORDER BY COALESCE(a.steam_linked_at, a.chzzk_linked_at) DESC`).all() as Row[]).map((r) => ({ ...rowToLink(r), lastName: r.lastName, lastSeen: r.lastSeen }));
  }

  // steamId -> link for the given players. Called every poll, so one query for the whole list.
  linksBySteam(steamIds: string[]): Map<string, Link> {
    if (!steamIds.length) return new Map();
    const rows = this.q.linksBySteam.all(JSON.stringify(steamIds)) as Row[];
    return new Map(rows.map((r) => [r.steamId, rowToLink(r)]));
  }

  whitelist(): Whitelist {
    const row = this.q.whitelist.get() as Row | undefined;
    return { ...WHITELIST_DEFAULT, ...(row ? JSON.parse(row.value) : {}) };
  }

  setWhitelist(value: Whitelist): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('whitelist', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(value));
  }

  whitelistBans(): WhitelistBan[] {
    return (this.q.whitelistBans.all() as Row[]).map((r) => ({ ...r, linked: !!r.linked }) as WhitelistBan);
  }

  addWhitelistBan(steamId: string, name: string | null | undefined): void {
    this.db.prepare(`INSERT INTO whitelist_bans (steam_id, name, created_at) VALUES (?, ?, ?)
      ON CONFLICT(steam_id) DO UPDATE SET last_error = NULL`).run(steamId, name ?? null, Date.now());
  }

  removeWhitelistBan(steamId: string): void {
    this.db.prepare('DELETE FROM whitelist_bans WHERE steam_id = ?').run(steamId);
  }

  noteWhitelistBanError(steamId: string, error: string): void {
    this.db.prepare('UPDATE whitelist_bans SET last_error = ? WHERE steam_id = ?').run(error, steamId);
  }
}

// Everything run per poll or per feed event; node:sqlite has no statement cache of its own.
function prepareQueries(db: DatabaseSync) {
  return {
    hasKill: db.prepare('SELECT 1 FROM kills WHERE event_id = ?'),
    matchStats: db.prepare(`
      SELECT killer_steam AS steamId, COUNT(*) AS kills, SUM(headshot) AS headshots, SUM(teamkill) AS teamkills,
             MAX(distance_m) AS maxDistance
      FROM kills WHERE match_key = ? AND killer_steam IS NOT NULL AND suicide = 0
      GROUP BY killer_steam`),
    pendingBans: db.prepare('SELECT * FROM pending_bans ORDER BY created_at DESC'),
    linksBySteam: db.prepare(`SELECT ${LINK_COLUMNS} FROM account_links a
      WHERE a.steam_id IN (SELECT value FROM json_each(?))`),
    whitelist: db.prepare("SELECT value FROM settings WHERE key = 'whitelist'"),
    whitelistBans: db.prepare(`SELECT w.steam_id AS steamId, w.name, w.created_at AS createdAt, w.last_error AS lastError,
        a.steam_id IS NOT NULL AS linked
      FROM whitelist_bans w LEFT JOIN account_links a ON a.steam_id = w.steam_id
      ORDER BY w.created_at DESC`),
    insertKill: db.prepare(`INSERT OR IGNORE INTO kills
      (event_id, received_at, match_key, map, event_time, killer_steam, killer_name, killer_faction,
       victim_steam, victim_name, victim_faction, cause, weapon, distance_m, tags, headshot, suicide, teamkill, engagement_id)
      VALUES (:eventId, :receivedAt, :matchKey, :map, :eventTime, :killerSteamId, :killerName, :killerFaction,
       :victimSteamId, :victimName, :victimFaction, :cause, :weapon, :distanceM, :tags, :headshot, :suicide, :teamkill, :engagementId)`),
    insertMatchEvent: db.prepare(`INSERT OR IGNORE INTO match_events
      (event_id, received_at, type, map, event_time, match_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    insertEngagement: db.prepare(`INSERT INTO engagements (match_key, map, started_at, ended_at, start_time, end_time)
      VALUES (?, ?, ?, ?, ?, ?)`),
    updateEngagement: db.prepare(`UPDATE engagements SET ended_at = :endedAt, end_time = :endTime, kills = :kills,
      headshots = :headshots, teamkills = :teamkills, distance_sum = :distanceSum, distance_n = :distanceN,
      factions = :factions, participants = :participants, weapons = :weapons WHERE id = :id`),
    insertFeedRequest: db.prepare(`INSERT INTO feed_requests (at, peer, status, code, events, accepted, duplicates, error)
      VALUES (:at, :peer, :status, :code, :events, :accepted, :duplicates, :error)`),
    pruneFeedRequests: db.prepare('DELETE FROM feed_requests WHERE id <= ?'),
    insertAction: db.prepare(`INSERT INTO actions (at, actor, action, target, detail, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    upsertPlayer: db.prepare(`INSERT INTO players (steam_id, first_seen, last_seen, last_name, sessions)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(steam_id) DO UPDATE SET last_seen = excluded.last_seen, last_name = excluded.last_name,
        sessions = sessions + ?`),
    // Deltas, not totals: a dashboard restart or a rejoin then never double-counts or loses a row.
    addMatchPlayer: db.prepare(`INSERT INTO match_players
      (match_key, steam_id, map, faction, kills, deaths, cash_peak, cash_earned, first_seen, last_seen)
      VALUES (:matchKey, :steamId, :map, :faction, :kills, :deaths, :cashPeak, :earned, :at, :at)
      ON CONFLICT(match_key, steam_id) DO UPDATE SET
        map = COALESCE(excluded.map, map),
        faction = COALESCE(excluded.faction, faction),
        kills = kills + excluded.kills,
        deaths = deaths + excluded.deaths,
        cash_peak = CASE WHEN cash_peak IS NULL THEN excluded.cash_peak
          WHEN excluded.cash_peak IS NULL THEN cash_peak ELSE MAX(cash_peak, excluded.cash_peak) END,
        cash_earned = cash_earned + excluded.cash_earned,
        last_seen = excluded.last_seen`),
    upsertName: db.prepare(`INSERT INTO player_names (steam_id, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
      ON CONFLICT(steam_id, name) DO UPDATE SET last_seen = excluded.last_seen`),
  };
}

// SQLAlchemy writes DATETIME as 'YYYY-MM-DD HH:MM:SS.ffffff' in UTC, without an offset.
function sqlTimeToMs(v: unknown): number | null {
  if (!v) return null;
  const ms = Date.parse(`${String(v).replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function rowToLink(r: Row): Link {
  return { ...r, steamLinkedAt: sqlTimeToMs(r.steamLinkedAt), chzzkLinkedAt: sqlTimeToMs(r.chzzkLinkedAt) } as Link;
}

function rowToKill(r: Row): Kill {
  return {
    eventId: r.event_id,
    receivedAt: r.received_at,
    matchKey: r.match_key,
    map: r.map,
    eventTime: r.event_time,
    killerSteamId: r.killer_steam,
    killerName: r.killer_name,
    killerFaction: r.killer_faction,
    victimSteamId: r.victim_steam,
    victimName: r.victim_name,
    victimFaction: r.victim_faction,
    cause: r.cause,
    weapon: r.weapon,
    distanceM: r.distance_m,
    tags: JSON.parse(r.tags),
    headshot: !!r.headshot,
    suicide: !!r.suicide,
    teamkill: !!r.teamkill,
    engagementId: r.engagement_id,
  };
}

function rowToEngagement(r: Row): Engagement {
  return {
    id: r.id,
    matchKey: r.match_key,
    map: r.map,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    startTime: r.start_time,
    endTime: r.end_time,
    kills: r.kills,
    headshots: r.headshots,
    teamkills: r.teamkills,
    avgDistance: r.distance_n ? r.distance_sum / r.distance_n : null,
    factions: JSON.parse(r.factions),
    participants: JSON.parse(r.participants),
    weapons: JSON.parse(r.weapons),
  };
}

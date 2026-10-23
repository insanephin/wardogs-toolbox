import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigPreset } from './settings.ts';

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

CREATE TABLE IF NOT EXISTS account_links (
  steam_id TEXT PRIMARY KEY,
  steam_name TEXT,
  chzzk_channel_id TEXT NOT NULL UNIQUE,
  chzzk_name TEXT,
  linked_at DATETIME
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  reporter_chzzk_id TEXT, reporter_chzzk_name TEXT,
  reporter_steam_id TEXT, reporter_steam_name TEXT,
  target_name TEXT NOT NULL,
  target_steam_id TEXT,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_url TEXT,
  map TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  handled_by TEXT,
  handled_at INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS reports_created ON reports(created_at);

CREATE TABLE IF NOT EXISTS discord_links (
  discord_id TEXT PRIMARY KEY,
  discord_name TEXT,
  steam_id TEXT NOT NULL UNIQUE,
  steam_name TEXT,
  chzzk_channel_id TEXT,
  chzzk_name TEXT,
  linked_at INTEGER NOT NULL,
  reserved INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS discord_releases (
  steam_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS whitelist_bans (
  steam_id TEXT PRIMARY KEY,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_error TEXT
);
`;

const LINK_COLUMNS = `a.steam_id AS steamId, a.steam_name AS steamName,
  a.chzzk_channel_id AS chzzkChannelId, a.chzzk_name AS chzzkName, a.linked_at AS linkedAt`;

const FEED_REQUEST_KEEP = 5000;

export const WHITELIST_MODES = ['off', 'kick', 'ban'] as const;
export type WhitelistMode = (typeof WHITELIST_MODES)[number];
export interface Whitelist {
  mode: WhitelistMode;
  message: string;
}
const WHITELIST_DEFAULT: Whitelist = { mode: 'off', message: '화이트리스트에 등록되지 않은 유저입니다.' };

export interface EntryGate {
  active: boolean;
  threshold: number;
  message: string;
  startedAt: number | null;
  openAt: number | null;
}
const ENTRY_GATE_DEFAULT: EntryGate = {
  active: false, threshold: 5, message: '스트리머 입장 중입니다. 잠시 후 다시 접속해주세요.', startedAt: null, openAt: null,
};

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
  steamId: string;
  steamName: string | null;
  chzzkChannelId: string;
  chzzkName: string | null;
  linkedAt: number | null;
}

type LinkWithSeen = Link & { lastName: string | null; lastSeen: number | null };

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

export interface DiscordLink {
  discordId: string;
  discordName: string | null;
  steamId: string;
  steamName: string | null;
  chzzkChannelId: string | null;
  chzzkName: string | null;
  linkedAt: number;
  reserved: boolean;
  lastError: string | null;
}

const DISCORD_COLUMNS = `discord_id AS discordId, discord_name AS discordName, steam_id AS steamId, steam_name AS steamName,
  chzzk_channel_id AS chzzkChannelId, chzzk_name AS chzzkName, linked_at AS linkedAt, reserved, last_error AS lastError`;

const rowToDiscordLink = (r: Row): DiscordLink => ({ ...r, reserved: !!r.reserved }) as DiscordLink;

export interface Report {
  id: number;
  createdAt: number;
  reporterChzzkId: string | null;
  reporterChzzkName: string | null;
  reporterSteamId: string | null;
  reporterSteamName: string | null;
  targetName: string;
  targetSteamId: string | null;
  category: string;
  description: string;
  evidenceUrl: string | null;
  map: string | null;
  status: string;
  handledBy: string | null;
  handledAt: number | null;
  note: string | null;
}

type NewReport = Omit<Report, 'id' | 'status' | 'handledBy' | 'handledAt' | 'note'>;

const REPORT_COLUMNS = `id, created_at AS createdAt,
  reporter_chzzk_id AS reporterChzzkId, reporter_chzzk_name AS reporterChzzkName,
  reporter_steam_id AS reporterSteamId, reporter_steam_name AS reporterSteamName,
  target_name AS targetName, target_steam_id AS targetSteamId, category, description,
  evidence_url AS evidenceUrl, map, status, handled_by AS handledBy, handled_at AS handledAt, note`;

export class Store {
  db: DatabaseSync;
  q: ReturnType<typeof prepareQueries>;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    const cols = new Set((this.db.prepare('PRAGMA table_info(discord_links)').all() as Row[]).map((c) => c.name));
    for (const c of ['chzzk_channel_id', 'chzzk_name']) if (!cols.has(c)) this.db.exec(`ALTER TABLE discord_links ADD COLUMN ${c} TEXT`);
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

  addReport(r: NewReport): Report {
    const { lastInsertRowid } = this.db.prepare(`INSERT INTO reports
      (created_at, reporter_chzzk_id, reporter_chzzk_name, reporter_steam_id, reporter_steam_name,
       target_name, target_steam_id, category, description, evidence_url, map)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.createdAt, r.reporterChzzkId, r.reporterChzzkName,
      r.reporterSteamId, r.reporterSteamName, r.targetName, r.targetSteamId, r.category, r.description, r.evidenceUrl, r.map);
    return this.report(Number(lastInsertRowid))!;
  }

  report(id: number): Report | null {
    return (this.db.prepare(`SELECT ${REPORT_COLUMNS} FROM reports WHERE id = ?`).get(id) as Row | undefined) as Report | undefined ?? null;
  }

  reportsByReporter(chzzkId: string, { since = 0, limit = 50 } = {}): Report[] {
    return this.db.prepare(`SELECT ${REPORT_COLUMNS} FROM reports
      WHERE reporter_chzzk_id = ? AND created_at >= ?
      ORDER BY id DESC LIMIT ?`).all(chzzkId, since, limit) as Row[] as Report[];
  }

  reports({ status, limit = 200 }: { status?: string; limit?: number } = {}): Report[] {
    return this.db.prepare(`SELECT ${REPORT_COLUMNS} FROM reports WHERE (:status IS NULL OR status = :status)
      ORDER BY id DESC LIMIT :limit`).all({ status: status ?? null, limit }) as Row[] as Report[];
  }

  updateReport(id: number, status: string, note: string | null, by: string, at: number): Report | null {
    this.db.prepare('UPDATE reports SET status = ?, note = ?, handled_by = ?, handled_at = ? WHERE id = ?').run(status, note, by, at, id);
    return this.report(id);
  }

  steamIdByName(name: string): string | null {
    const r = this.db.prepare('SELECT steam_id FROM player_names WHERE name = ? ORDER BY last_seen DESC LIMIT 1').get(name) as Row | undefined;
    return r?.steam_id ?? null;
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
    this.q.pruneFeedRequests.run(id - FEED_REQUEST_KEEP);
  }

  feedRequests(limit = 300) {
    return this.db.prepare('SELECT * FROM feed_requests ORDER BY id DESC LIMIT ?').all(limit);
  }

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

  links(): LinkWithSeen[] {
    return (this.db.prepare(`SELECT ${LINK_COLUMNS}, p.last_name AS lastName, p.last_seen AS lastSeen
      FROM account_links a LEFT JOIN players p ON p.steam_id = a.steam_id
      ORDER BY a.linked_at DESC`).all() as Row[]).map((r) => ({ ...rowToLink(r), lastName: r.lastName, lastSeen: r.lastSeen }));
  }

  linkByAccount(provider: 'chzzk' | 'steam', id: string): Link | null {
    const col = provider === 'chzzk' ? 'chzzk_channel_id' : 'steam_id';
    const r = this.db.prepare(`SELECT ${LINK_COLUMNS} FROM account_links a WHERE a.${col} = ?`).get(id) as Row | undefined;
    return r ? rowToLink(r) : null;
  }

  saveLink(steamId: string, steamName: string, chzzkChannelId: string, chzzkName: string, linkedAt: string): void {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM account_links WHERE steam_id = ? OR chzzk_channel_id = ?').run(steamId, chzzkChannelId);
      this.db.prepare('INSERT INTO account_links (steam_id, steam_name, chzzk_channel_id, chzzk_name, linked_at) VALUES (?, ?, ?, ?, ?)')
        .run(steamId, steamName, chzzkChannelId, chzzkName, linkedAt);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  linkIfFree(steam: { id: string; name: string }, chzzk: { id: string; name: string }, linkedAt: string): boolean {
    const taken = [this.linkByAccount('steam', steam.id), this.linkByAccount('chzzk', chzzk.id)]
      .some((l) => l && (l.steamId !== steam.id || l.chzzkChannelId !== chzzk.id));
    if (taken) return false;
    this.saveLink(steam.id, steam.name, chzzk.id, chzzk.name, linkedAt);
    return true;
  }

  unlink(steamId: string): void {
    this.db.prepare('DELETE FROM account_links WHERE steam_id = ?').run(steamId);
  }

  linksBySteam(steamIds: string[]): Map<string, Link> {
    if (!steamIds.length) return new Map();
    const rows = this.q.linksBySteam.all(JSON.stringify(steamIds)) as Row[];
    return new Map(rows.map((r) => [r.steamId, rowToLink(r)]));
  }

  discordLink(by: 'discord' | 'steam', id: string): DiscordLink | null {
    const col = by === 'discord' ? 'discord_id' : 'steam_id';
    const r = this.db.prepare(`SELECT ${DISCORD_COLUMNS} FROM discord_links WHERE ${col} = ?`).get(id) as Row | undefined;
    return r ? rowToDiscordLink(r) : null;
  }

  discordLinks({ unreserved = false } = {}): DiscordLink[] {
    return (this.db.prepare(`SELECT ${DISCORD_COLUMNS} FROM discord_links ${unreserved ? 'WHERE reserved = 0' : ''}
      ORDER BY linked_at DESC`).all() as Row[]).map(rowToDiscordLink);
  }

  saveDiscordLink(discordId: string, discordName: string, link: Link, at: number): void {
    this.db.prepare(`INSERT INTO discord_links (discord_id, discord_name, steam_id, steam_name, chzzk_channel_id, chzzk_name, linked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(discord_id) DO UPDATE SET discord_name = excluded.discord_name, steam_name = excluded.steam_name,
        chzzk_channel_id = excluded.chzzk_channel_id, chzzk_name = excluded.chzzk_name, linked_at = excluded.linked_at,
        reserved = CASE WHEN steam_id = excluded.steam_id THEN reserved ELSE 0 END,
        last_error = CASE WHEN steam_id = excluded.steam_id THEN last_error ELSE NULL END,
        steam_id = excluded.steam_id`).run(discordId, discordName, link.steamId, link.steamName, link.chzzkChannelId, link.chzzkName, at);
  }

  discordLinksBySteam(steamIds: string[]): Map<string, DiscordLink> {
    if (!steamIds.length) return new Map();
    const rows = this.db.prepare(`SELECT ${DISCORD_COLUMNS} FROM discord_links
      WHERE steam_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(steamIds)) as Row[];
    return new Map(rows.map((r) => [r.steamId, rowToDiscordLink(r)]));
  }

  removeDiscordLink(discordId: string): void {
    this.db.prepare('DELETE FROM discord_links WHERE discord_id = ?').run(discordId);
  }

  markDiscordReserved(steamId: string, error: string | null): void {
    this.db.prepare('UPDATE discord_links SET reserved = ?, last_error = ? WHERE steam_id = ?').run(error ? 0 : 1, error, steamId);
  }

  discordReleases(): string[] {
    return (this.db.prepare('SELECT steam_id FROM discord_releases ORDER BY created_at').all() as Row[]).map((r) => r.steam_id);
  }

  addDiscordRelease(steamId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO discord_releases (steam_id, created_at) VALUES (?, ?)').run(steamId, Date.now());
  }

  removeDiscordRelease(steamId: string): void {
    this.db.prepare('DELETE FROM discord_releases WHERE steam_id = ?').run(steamId);
  }

  whitelist(): Whitelist {
    const row = this.q.whitelist.get() as Row | undefined;
    return { ...WHITELIST_DEFAULT, ...(row ? JSON.parse(row.value) : {}) };
  }

  setWhitelist(value: Whitelist): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('whitelist', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(value));
  }

  entryGate(): EntryGate {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'entry_gate'").get() as Row | undefined;
    return { ...ENTRY_GATE_DEFAULT, ...(row ? JSON.parse(row.value) : {}) };
  }

  setEntryGate(value: EntryGate): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('entry_gate', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(value));
  }

  configPresets(): ConfigPreset[] {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'config_presets'").get() as Row | undefined;
    return row ? JSON.parse(row.value) : [];
  }

  setConfigPresets(list: ConfigPreset[]): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('config_presets', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(list));
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
        (a.steam_id IS NOT NULL OR d.steam_id IS NOT NULL) AS linked
      FROM whitelist_bans w LEFT JOIN account_links a ON a.steam_id = w.steam_id
      LEFT JOIN discord_links d ON d.steam_id = w.steam_id
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

function sqlTimeToMs(v: unknown): number | null {
  if (!v) return null;
  const ms = Date.parse(`${String(v).replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function rowToLink(r: Row): Link {
  return { ...r, linkedAt: sqlTimeToMs(r.linkedAt) } as Link;
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

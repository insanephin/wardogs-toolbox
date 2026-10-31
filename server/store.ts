import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigPreset } from './settings.ts';
import { createSecretBox, isSealed } from './secret.ts';
import type { SecretBox } from './secret.ts';

const SCHEMA_VERSION = 2;

const GLOBAL_TABLES = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  steam_id TEXT PRIMARY KEY,
  name TEXT,
  avatar TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_identities (
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  steam_id TEXT NOT NULL,
  name TEXT,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_id),
  UNIQUE (steam_id, provider)
);

CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rcon_url TEXT NOT NULL DEFAULT '',
  rcon_password TEXT NOT NULL DEFAULT '',
  feed_token TEXT NOT NULL UNIQUE,
  public INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  join_code TEXT
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id INTEGER NOT NULL,
  steam_id TEXT NOT NULL,
  role TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT,
  PRIMARY KEY (server_id, steam_id)
);
CREATE INDEX IF NOT EXISTS server_members_steam ON server_members(steam_id);

CREATE TABLE IF NOT EXISTS panel_sessions (
  token_hash TEXT PRIMARY KEY,
  steam_id TEXT NOT NULL,
  name TEXT NOT NULL,
  guest INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_links (
  steam_id TEXT PRIMARY KEY,
  steam_name TEXT,
  chzzk_channel_id TEXT NOT NULL UNIQUE,
  chzzk_name TEXT,
  linked_at DATETIME
);
`;

const SERVER_TABLES: Record<string, string> = {
  kills: `CREATE TABLE IF NOT EXISTS kills (
  server_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
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
  engagement_id INTEGER,
  PRIMARY KEY (server_id, event_id)
)`,
  match_events: `CREATE TABLE IF NOT EXISTS match_events (
  server_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  map TEXT,
  event_time REAL,
  match_id TEXT,
  payload TEXT NOT NULL,
  PRIMARY KEY (server_id, event_id)
)`,
  engagements: `CREATE TABLE IF NOT EXISTS engagements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
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
)`,
  actions: `CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  ok INTEGER NOT NULL,
  error TEXT
)`,
  players: `CREATE TABLE IF NOT EXISTS players (
  server_id INTEGER NOT NULL,
  steam_id TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  last_name TEXT,
  sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, steam_id)
)`,
  player_names: `CREATE TABLE IF NOT EXISTS player_names (
  server_id INTEGER NOT NULL,
  steam_id TEXT NOT NULL,
  name TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (server_id, steam_id, name)
)`,
  pending_bans: `CREATE TABLE IF NOT EXISTS pending_bans (
  server_id INTEGER NOT NULL,
  steam_id TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (server_id, steam_id)
)`,
  server_settings: `CREATE TABLE IF NOT EXISTS server_settings (
  server_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (server_id, key)
)`,
  match_players: `CREATE TABLE IF NOT EXISTS match_players (
  server_id INTEGER NOT NULL,
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
  PRIMARY KEY (server_id, match_key, steam_id)
)`,
  match_results: `CREATE TABLE IF NOT EXISTS match_results (
  server_id INTEGER NOT NULL,
  match_key TEXT NOT NULL,
  winning_faction TEXT,
  ended_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, match_key)
)`,
  feed_requests: `CREATE TABLE IF NOT EXISTS feed_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER,
  at INTEGER NOT NULL,
  peer TEXT,
  status INTEGER NOT NULL,
  code TEXT,
  events INTEGER,
  accepted INTEGER,
  duplicates INTEGER,
  error TEXT
)`,
  report_images: `CREATE TABLE IF NOT EXISTS report_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  report_id INTEGER NOT NULL,
  file TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`,
  reports: `CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  reporter_chzzk_id TEXT, reporter_chzzk_name TEXT,
  reporter_steam_id TEXT, reporter_steam_name TEXT,
  reporter_discord_id TEXT, reporter_discord_name TEXT,
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
)`,
  whitelist_bans: `CREATE TABLE IF NOT EXISTS whitelist_bans (
  server_id INTEGER NOT NULL,
  steam_id TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_error TEXT,
  PRIMARY KEY (server_id, steam_id)
)`,
  discord_links: `CREATE TABLE IF NOT EXISTS discord_links (
  server_id INTEGER NOT NULL,
  discord_id TEXT NOT NULL,
  discord_name TEXT,
  steam_id TEXT NOT NULL,
  steam_name TEXT,
  chzzk_channel_id TEXT,
  chzzk_name TEXT,
  linked_at INTEGER NOT NULL,
  reserved INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (server_id, discord_id),
  UNIQUE (server_id, steam_id)
)`,
  chzzk_subscribers: `CREATE TABLE IF NOT EXISTS chzzk_subscribers (
  server_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (server_id, channel_id)
)`,
  chzzk_followers: `CREATE TABLE IF NOT EXISTS chzzk_followers (
  server_id INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (server_id, channel_id)
)`,
  discord_releases: `CREATE TABLE IF NOT EXISTS discord_releases (
  server_id INTEGER NOT NULL,
  steam_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, steam_id)
)`,
};

const SERVER_INDEXES = `
CREATE INDEX IF NOT EXISTS report_images_report ON report_images(server_id, report_id);
CREATE INDEX IF NOT EXISTS kills_received ON kills(server_id, received_at);
CREATE INDEX IF NOT EXISTS kills_killer ON kills(server_id, killer_steam);
CREATE INDEX IF NOT EXISTS kills_victim ON kills(server_id, victim_steam);
CREATE INDEX IF NOT EXISTS kills_match ON kills(server_id, match_key);
CREATE INDEX IF NOT EXISTS kills_engagement ON kills(engagement_id);
CREATE INDEX IF NOT EXISTS match_events_received ON match_events(server_id, received_at);
CREATE INDEX IF NOT EXISTS engagements_started ON engagements(server_id, started_at);
CREATE INDEX IF NOT EXISTS actions_at ON actions(server_id, at);
CREATE INDEX IF NOT EXISTS player_names_name ON player_names(server_id, name);
CREATE INDEX IF NOT EXISTS match_players_seen ON match_players(server_id, last_seen);
CREATE INDEX IF NOT EXISTS feed_requests_server ON feed_requests(server_id, id);
CREATE INDEX IF NOT EXISTS reports_created ON reports(server_id, created_at);
CREATE INDEX IF NOT EXISTS reports_reporter ON reports(reporter_chzzk_id, created_at);
CREATE INDEX IF NOT EXISTS reports_steam_reporter ON reports(reporter_steam_id, created_at);
CREATE INDEX IF NOT EXISTS reports_discord_reporter ON reports(reporter_discord_id, created_at);
CREATE INDEX IF NOT EXISTS discord_links_steam ON discord_links(steam_id);
`;

const LEGACY_INDEXES = ['kills_received', 'kills_killer', 'kills_victim', 'kills_match', 'match_events_received', 'engagements_started',
  'actions_at', 'match_players_seen', 'reports_created'];
const LEGACY_SERVER_KEYS = ['whitelist', 'entry_gate', 'turnover', 'config_presets'];

const LINK_COLUMNS = `a.steam_id AS steamId, a.steam_name AS steamName,
  a.chzzk_channel_id AS chzzkChannelId, a.chzzk_name AS chzzkName, a.linked_at AS linkedAt`;

const FEED_REQUEST_KEEP = 5000;

export const ROLES = ['viewer', 'mod', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];
export interface DiscordGuild {
  id: string;
  name: string;
}

export const IDENTITY_PROVIDERS = ['discord', 'chzzk', 'twitch'] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export const WHITELIST_MODES = ['off', 'kick', 'ban'] as const;
export type WhitelistMode = (typeof WHITELIST_MODES)[number];
export const WHITELIST_AUDIENCES = ['linked', 'follower', 'subscriber'] as const;
export type WhitelistAudience = (typeof WHITELIST_AUDIENCES)[number];
export interface Whitelist {
  mode: WhitelistMode;
  message: string;
  audience: WhitelistAudience;
}
const WHITELIST_DEFAULT: Whitelist = { mode: 'off', message: '화이트리스트에 등록되지 않은 유저입니다.', audience: 'linked' };

export type ChzzkAudience = Exclude<WhitelistAudience, 'linked'>;
const AUDIENCE_TABLE: Record<ChzzkAudience, string> = { follower: 'chzzk_followers', subscriber: 'chzzk_subscribers' };

export interface ChzzkOwner {
  channelId: string;
  channelName: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  connectedBy: string;
  connectedAt: number;
  syncedAt: number | null;
  count: number;
  error: string | null;
  followerSyncedAt?: number | null;
  followerCount?: number;
  followerError?: string | null;
}

export interface EntryGate {
  active: boolean;
  threshold: number;
  message: string;
  startedAt: number | null;
  openAt: number | null;
}
const ENTRY_GATE_DEFAULT: EntryGate = {
  active: false, threshold: 5, message: '화이트리스트 입장 시간입니다. 잠시 후 다시 접속해주세요.', startedAt: null, openAt: null,
};

export interface Turnover {
  enabled: boolean;
  message: string;
}
const TURNOVER_DEFAULT: Turnover = { enabled: false, message: '미참여 대기인원 우선 입장중입니다. 30초 뒤 다시 시도해주세요.' };

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

export type StreamerPair = Pick<DiscordLink, 'steamId' | 'steamName' | 'chzzkChannelId' | 'chzzkName'>;

const DISCORD_COLUMNS = `discord_id AS discordId, discord_name AS discordName, steam_id AS steamId, steam_name AS steamName,
  chzzk_channel_id AS chzzkChannelId, chzzk_name AS chzzkName, linked_at AS linkedAt, reserved, last_error AS lastError`;

const rowToDiscordLink = (r: Row): DiscordLink => ({ ...r, reserved: !!r.reserved }) as DiscordLink;

export interface Report {
  id: number;
  serverId: number;
  createdAt: number;
  reporterChzzkId: string | null;
  reporterChzzkName: string | null;
  reporterSteamId: string | null;
  reporterSteamName: string | null;
  reporterDiscordId: string | null;
  reporterDiscordName: string | null;
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

export interface ReportImage {
  id: number;
  reportId: number;
  file: string;
  mime: string;
  size: number;
  createdAt: number;
}

export type NewReport = Omit<Report, 'id' | 'serverId' | 'status' | 'handledBy' | 'handledAt' | 'note'>;

const REPORT_COLUMNS = `id, server_id AS serverId, created_at AS createdAt,
  reporter_chzzk_id AS reporterChzzkId, reporter_chzzk_name AS reporterChzzkName,
  reporter_steam_id AS reporterSteamId, reporter_steam_name AS reporterSteamName,
  reporter_discord_id AS reporterDiscordId, reporter_discord_name AS reporterDiscordName,
  target_name AS targetName, target_steam_id AS targetSteamId, category, description,
  evidence_url AS evidenceUrl, map, status, handled_by AS handledBy, handled_at AS handledAt, note`;

export interface ServerRow {
  id: number;
  name: string;
  rconUrl: string;
  rconPassword: string;
  feedToken: string;
  createdAt: number;
  createdBy: string | null;
  joinCode: string | null;
}

const SERVER_COLUMNS = `id, name, rcon_url AS rconUrl, rcon_password AS rconPassword, feed_token AS feedToken,
  created_at AS createdAt, created_by AS createdBy, join_code AS joinCode`;

export interface User {
  steamId: string;
  name: string | null;
  avatar: string | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface Member {
  steamId: string;
  role: Role;
  name: string | null;
  avatar: string | null;
  addedAt: number;
  addedBy: string | null;
  lastLoginAt: number | null;
}

export interface Identity {
  provider: IdentityProvider;
  providerId: string;
  name: string | null;
  linkedAt: number;
}

const MAX_GUEST_SESSIONS = 300;

export const newFeedToken = () => randomBytes(24).toString('base64url');

interface StoreOptions {
  legacyFeedToken?: string;
  legacyDiscordServerId?: number;
  secretKey?: string;
}

export interface StoredSession {
  steamId: string;
  name: string;
  guest: boolean;
  expires: number;
}

export class Store {
  db: DatabaseSync;
  #stmts = new Map<string, StatementSync>();
  #scoped = new Map<number, ServerStore>();
  #secrets: SecretBox;

  constructor(path: string, { legacyFeedToken = '', legacyDiscordServerId = 1, secretKey = '' }: StoreOptions = {}) {
    this.#secrets = createSecretBox(secretKey);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate(path, legacyFeedToken, legacyDiscordServerId);
    this.#sealPlainSecrets();
  }

  prep(sql: string): StatementSync {
    let s = this.#stmts.get(sql);
    if (!s) this.#stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  sealSecret(plain: string): string {
    return this.#secrets.seal(plain);
  }

  openSecret(stored: string): string {
    return this.#secrets.open(stored);
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  columns(table: string): Set<string> {
    return new Set((this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => c.name));
  }

  migrate(path: string, legacyFeedToken: string, legacyDiscordServerId: number): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    if (version > SCHEMA_VERSION) throw new Error(`DB schema v${version} is newer than this build (v${SCHEMA_VERSION})`);
    const legacy = version === 0 && this.columns('kills').size > 0 && !this.columns('kills').has('server_id');
    const globalDiscord = !legacy && this.columns('discord_links').size > 0 && !this.columns('discord_links').has('server_id');
    if ((legacy || globalDiscord) && path !== ':memory:' && existsSync(path)) {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const backup = `${path}.v${version}-${Date.now()}.bak`;
      copyFileSync(path, backup);
      console.log(`[DB] 스키마를 옮기기 전에 백업했습니다: ${backup}`);
    }
    this.tx(() => {
      if (legacy) {
        const dc = this.columns('discord_links');
        for (const c of ['chzzk_channel_id', 'chzzk_name']) if (dc.size && !dc.has(c)) this.db.exec(`ALTER TABLE discord_links ADD COLUMN ${c} TEXT`);
      }
      this.db.exec(GLOBAL_TABLES);
      if (!this.columns('servers').has('join_code')) this.db.exec('ALTER TABLE servers ADD COLUMN join_code TEXT');
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS servers_join_code ON servers(join_code) WHERE join_code IS NOT NULL');
      if (this.columns('servers').has('panel_key')) {
        this.db.exec('DROP INDEX IF EXISTS servers_panel_key');
        this.db.exec('ALTER TABLE servers DROP COLUMN panel_key');
      }
      for (const c of ['discord_guild_id', 'discord_guild_name']) {
        if (!this.columns('servers').has(c)) this.db.exec(`ALTER TABLE servers ADD COLUMN ${c} TEXT`);
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS servers_discord_guild ON servers(discord_guild_id) WHERE discord_guild_id IS NOT NULL');
      if (legacy) this.migrateV0(legacyFeedToken);
      if (globalDiscord) this.migrateV1(legacyDiscordServerId);
      for (const sql of Object.values(SERVER_TABLES)) this.db.exec(sql);
      const rc = this.columns('reports');
      for (const c of ['reporter_discord_id', 'reporter_discord_name']) if (!rc.has(c)) this.db.exec(`ALTER TABLE reports ADD COLUMN ${c} TEXT`);
      this.db.exec(SERVER_INDEXES);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  migrateV0(legacyFeedToken: string): void {
    const setting = (key: string) => (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined)?.value;
    const rcon = JSON.parse(setting('rcon') ?? '{}');
    this.db.prepare(`INSERT INTO servers (id, name, rcon_url, rcon_password, feed_token, public, created_at)
      VALUES (1, ?, ?, ?, ?, 1, ?)`).run('WARDOGS', rcon.url ?? '', rcon.password ?? '', legacyFeedToken || newFeedToken(), Date.now());
    for (const name of LEGACY_INDEXES) this.db.exec(`DROP INDEX IF EXISTS ${name}`);
    for (const table of Object.keys(SERVER_TABLES)) this.rescope(table, 1);
    this.db.exec(SERVER_TABLES.server_settings!);
    for (const key of LEGACY_SERVER_KEYS) {
      const value = setting(key);
      if (value != null) this.db.prepare('INSERT INTO server_settings (server_id, key, value) VALUES (1, ?, ?)').run(key, value);
    }
    this.db.prepare(`DELETE FROM settings WHERE key IN (${[...LEGACY_SERVER_KEYS, 'rcon'].map(() => '?').join(', ')})`)
      .run(...LEGACY_SERVER_KEYS, 'rcon');
  }

  migrateV1(serverId: number): void {
    if (!this.server(serverId)) {
      const n = Number((this.db.prepare('SELECT COUNT(*) AS n FROM discord_links').get() as Row).n);
      console.warn(`[DB] 디스코드 화이트리스트를 옮길 서버 #${serverId}가 없어 연동 ${n}건을 버렸습니다`);
      this.db.exec('DROP TABLE discord_links; DROP TABLE IF EXISTS discord_releases');
      return;
    }
    for (const table of ['discord_links', 'discord_releases']) this.rescope(table, serverId);
    console.log(`[DB] 디스코드 화이트리스트를 서버 #${serverId}로 옮겼습니다`);
  }

  rescope(table: string, serverId: number): void {
    const old = this.columns(table);
    if (!old.size) return;
    this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}__old`);
    this.db.exec(SERVER_TABLES[table]!);
    const shared = [...this.columns(table)].filter((c) => c !== 'server_id' && old.has(c));
    this.db.prepare(`INSERT INTO ${table} (server_id, ${shared.join(', ')}) SELECT ?, ${shared.join(', ')} FROM ${table}__old`).run(serverId);
    this.db.exec(`DROP TABLE ${table}__old`);
  }

  forServer(id: number): ServerStore {
    let s = this.#scoped.get(id);
    if (!s) this.#scoped.set(id, (s = new ServerStore(this, id)));
    return s;
  }

  #rowToServer(r: Row): ServerRow {
    return { ...r, rconPassword: this.#secrets.open(r.rconPassword) } as ServerRow;
  }

  #sealPlainSecrets(): void {
    if (!this.#secrets.enabled) return;
    const rows = this.db.prepare("SELECT id, rcon_password FROM servers WHERE rcon_password != ''").all() as Row[];
    const plain = rows.filter((r) => !isSealed(r.rcon_password));
    if (!plain.length) return;
    this.tx(() => {
      for (const r of plain) this.prep('UPDATE servers SET rcon_password = ? WHERE id = ?').run(this.#secrets.seal(r.rcon_password), r.id);
    });
    console.log(`[DB] RCON 비밀번호 ${plain.length}개를 암호화했습니다`);
  }

  servers(): ServerRow[] {
    return (this.prep(`SELECT ${SERVER_COLUMNS} FROM servers ORDER BY id`).all() as Row[]).map((r) => this.#rowToServer(r));
  }

  server(id: number): ServerRow | null {
    const r = this.prep(`SELECT ${SERVER_COLUMNS} FROM servers WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.#rowToServer(r) : null;
  }

  createServer(name: string, rconUrl: string, rconPassword: string, by: string): ServerRow {
    return this.tx(() => {
      const { lastInsertRowid } = this.prep(`INSERT INTO servers (name, rcon_url, rcon_password, feed_token, created_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?)`).run(name, rconUrl, this.#secrets.seal(rconPassword), newFeedToken(), Date.now(), by);
      const id = Number(lastInsertRowid);
      this.setMember(id, by, 'owner', by);
      return this.server(id)!;
    });
  }

  updateServer(id: number, patch: Partial<Pick<ServerRow, 'name' | 'rconUrl' | 'rconPassword' | 'feedToken' | 'joinCode'>>): ServerRow | null {
    const cols: Record<string, string> = {
      name: 'name', rconUrl: 'rcon_url', rconPassword: 'rcon_password', feedToken: 'feed_token', joinCode: 'join_code',
    };
    const keys = Object.keys(patch).filter((k) => k in cols) as (keyof typeof patch)[];
    if (keys.length) {
      const values = keys.map((k) => (k === 'rconPassword' ? this.#secrets.seal(patch[k]!) : patch[k] as string));
      this.db.prepare(`UPDATE servers SET ${keys.map((k) => `${cols[k]} = ?`).join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.server(id);
  }

  discordGuild(id: number): DiscordGuild | null {
    const r = this.prep('SELECT discord_guild_id AS id, discord_guild_name AS name FROM servers WHERE id = ?').get(id) as Row | undefined;
    return r?.id ? { id: r.id, name: r.name ?? r.id } : null;
  }

  setDiscordGuild(id: number, guild: DiscordGuild | null): void {
    this.prep('UPDATE servers SET discord_guild_id = ?, discord_guild_name = ? WHERE id = ?').run(guild?.id ?? null, guild?.name ?? null, id);
  }

  serverIdsByDiscordGuild(guildId: string): number[] {
    return (this.prep('SELECT id FROM servers WHERE discord_guild_id = ? ORDER BY id').all(guildId) as Row[]).map((r) => Number(r.id));
  }

  renameWeapons(renames: [cause: string, name: string][]): void {
    this.tx(() => {
      for (const [cause, name] of renames) {
        const old = (this.prep('SELECT DISTINCT weapon FROM kills WHERE cause = ? AND weapon IS NOT NULL AND weapon != ?').all(cause, name) as Row[])
          .map((r) => r.weapon as string);
        if (!old.length) continue;
        this.prep('UPDATE kills SET weapon = ? WHERE cause = ?').run(name, cause);
        for (const from of old) {
          const rows = this.prep('SELECT id, weapons FROM engagements WHERE instr(weapons, ?) > 0').all(JSON.stringify(from)) as Row[];
          for (const r of rows) {
            const w = JSON.parse(r.weapons) as Record<string, number>;
            if (!(from in w)) continue;
            w[name] = (w[name] ?? 0) + w[from]!;
            delete w[from];
            this.prep('UPDATE engagements SET weapons = ? WHERE id = ?').run(JSON.stringify(w), r.id);
          }
        }
      }
    });
  }

  deleteServer(id: number): void {
    this.tx(() => {
      for (const table of Object.keys(SERVER_TABLES)) this.prep(`DELETE FROM ${table} WHERE server_id = ?`).run(id);
      this.prep('DELETE FROM server_members WHERE server_id = ?').run(id);
      this.prep('DELETE FROM servers WHERE id = ?').run(id);
    });
    this.#scoped.delete(id);
  }

  memberRole(serverId: number, steamId: string): Role | null {
    const r = this.prep('SELECT role FROM server_members WHERE server_id = ? AND steam_id = ?').get(serverId, steamId) as Row | undefined;
    return (r?.role as Role) ?? null;
  }

  memberships(steamId: string): { serverId: number; role: Role }[] {
    return this.prep('SELECT server_id AS serverId, role FROM server_members WHERE steam_id = ?').all(steamId) as Row[] as { serverId: number; role: Role }[];
  }

  members(serverId: number): Member[] {
    return this.prep(`SELECT m.steam_id AS steamId, m.role, m.added_at AS addedAt, m.added_by AS addedBy,
        u.name, u.avatar, u.last_login_at AS lastLoginAt
      FROM server_members m LEFT JOIN users u ON u.steam_id = m.steam_id
      WHERE m.server_id = ? ORDER BY m.added_at`).all(serverId) as Row[] as Member[];
  }

  setMember(serverId: number, steamId: string, role: Role, by: string): void {
    this.prep(`INSERT INTO server_members (server_id, steam_id, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_id, steam_id) DO UPDATE SET role = excluded.role`).run(serverId, steamId, role, Date.now(), by);
  }

  removeMember(serverId: number, steamId: string): boolean {
    return this.prep('DELETE FROM server_members WHERE server_id = ? AND steam_id = ?').run(serverId, steamId).changes > 0;
  }

  user(steamId: string): User | null {
    return (this.prep(`SELECT steam_id AS steamId, name, avatar, created_at AS createdAt, last_login_at AS lastLoginAt
      FROM users WHERE steam_id = ?`).get(steamId) as Row | undefined) as User | undefined ?? null;
  }

  touchUser(steamId: string, name: string | null, avatar: string | null, login: boolean): void {
    const now = Date.now();
    this.prep(`INSERT INTO users (steam_id, name, avatar, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(steam_id) DO UPDATE SET name = COALESCE(excluded.name, name), avatar = COALESCE(excluded.avatar, avatar),
        last_login_at = COALESCE(excluded.last_login_at, last_login_at)`).run(steamId, name, avatar, now, login ? now : null);
  }

  saveSession(tokenHash: string, s: StoredSession): void {
    this.prep('DELETE FROM panel_sessions WHERE expires < ?').run(Date.now());
    this.prep('INSERT INTO panel_sessions (token_hash, steam_id, name, guest, expires) VALUES (?, ?, ?, ?, ?)')
      .run(tokenHash, s.steamId, s.name, s.guest ? 1 : 0, s.expires);
    if (s.guest) {
      this.prep(`DELETE FROM panel_sessions WHERE guest = 1 AND token_hash NOT IN
        (SELECT token_hash FROM panel_sessions WHERE guest = 1 ORDER BY expires DESC LIMIT ?)`).run(MAX_GUEST_SESSIONS);
    }
  }

  session(tokenHash: string): StoredSession | null {
    const r = this.prep('SELECT steam_id, name, guest, expires FROM panel_sessions WHERE token_hash = ?').get(tokenHash) as Row | undefined;
    return r ? { steamId: r.steam_id, name: r.name, guest: !!r.guest, expires: r.expires } : null;
  }

  deleteSession(tokenHash: string): void {
    this.prep('DELETE FROM panel_sessions WHERE token_hash = ?').run(tokenHash);
  }

  identities(steamId: string): Identity[] {
    return this.prep(`SELECT provider, provider_id AS providerId, name, linked_at AS linkedAt
      FROM user_identities WHERE steam_id = ? ORDER BY provider`).all(steamId) as Row[] as Identity[];
  }

  identityOwner(provider: IdentityProvider, providerId: string): string | null {
    const r = this.prep('SELECT steam_id FROM user_identities WHERE provider = ? AND provider_id = ?').get(provider, providerId) as Row | undefined;
    return r?.steam_id ?? null;
  }

  linkIdentity(steamId: string, provider: IdentityProvider, providerId: string, name: string): boolean {
    const owner = this.identityOwner(provider, providerId);
    if (owner && owner !== steamId) return false;
    this.tx(() => {
      this.prep('DELETE FROM user_identities WHERE steam_id = ? AND provider = ?').run(steamId, provider);
      this.prep('INSERT INTO user_identities (provider, provider_id, steam_id, name, linked_at) VALUES (?, ?, ?, ?, ?)')
        .run(provider, providerId, steamId, name, Date.now());
    });
    return true;
  }

  unlinkIdentity(steamId: string, provider: IdentityProvider): boolean {
    return this.prep('DELETE FROM user_identities WHERE steam_id = ? AND provider = ?').run(steamId, provider).changes > 0;
  }

  linkByAccount(provider: 'chzzk' | 'steam', id: string): Link | null {
    const col = provider === 'chzzk' ? 'chzzk_channel_id' : 'steam_id';
    const r = this.prep(`SELECT ${LINK_COLUMNS} FROM account_links a WHERE a.${col} = ?`).get(id) as Row | undefined;
    return r ? rowToLink(r) : null;
  }

  saveLink(steamId: string, steamName: string, chzzkChannelId: string, chzzkName: string, linkedAt: string): void {
    this.tx(() => {
      this.prep('DELETE FROM account_links WHERE steam_id = ? OR chzzk_channel_id = ?').run(steamId, chzzkChannelId);
      this.prep('INSERT INTO account_links (steam_id, steam_name, chzzk_channel_id, chzzk_name, linked_at) VALUES (?, ?, ?, ?, ?)')
        .run(steamId, steamName, chzzkChannelId, chzzkName, linkedAt);
    });
  }

  linkIfFree(steam: { id: string; name: string }, chzzk: { id: string; name: string }, linkedAt: string): boolean {
    const taken = [this.linkByAccount('steam', steam.id), this.linkByAccount('chzzk', chzzk.id)]
      .some((l) => l && (l.steamId !== steam.id || l.chzzkChannelId !== chzzk.id));
    if (taken) return false;
    this.saveLink(steam.id, steam.name, chzzk.id, chzzk.name, linkedAt);
    return true;
  }

  unlink(steamId: string): void {
    this.prep('DELETE FROM account_links WHERE steam_id = ?').run(steamId);
  }

  linksBySteam(steamIds: string[]): Map<string, Link> {
    if (!steamIds.length) return new Map();
    const rows = this.prep(`SELECT ${LINK_COLUMNS} FROM account_links a
      WHERE a.steam_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(steamIds)) as Row[];
    return new Map(rows.map((r) => [r.steamId, rowToLink(r)]));
  }

  discordSteamTaken(steamId: string, discordId: string): boolean {
    return !!this.prep('SELECT 1 FROM discord_links WHERE steam_id = ? AND discord_id != ? LIMIT 1').get(steamId, discordId);
  }

  reportImage(id: number): (ReportImage & { serverId: number; reporterSteamId: string | null; reporterDiscordId: string | null }) | null {
    return (this.prep(`SELECT i.id, i.server_id AS serverId, i.report_id AS reportId, i.file, i.mime, i.size, i.created_at AS createdAt,
      r.reporter_steam_id AS reporterSteamId, r.reporter_discord_id AS reporterDiscordId
      FROM report_images i JOIN reports r ON r.id = i.report_id AND r.server_id = i.server_id WHERE i.id = ?`).get(id) as any) ?? null;
  }

  reportImagesBytes(): number {
    return Number((this.prep('SELECT COALESCE(SUM(size), 0) AS n FROM report_images').get() as Row).n);
  }

  reportImagesBytesBy(steamId: string, since: number): number {
    return Number((this.prep(`SELECT COALESCE(SUM(i.size), 0) AS n FROM report_images i
      JOIN reports r ON r.id = i.report_id AND r.server_id = i.server_id
      WHERE r.reporter_steam_id = ? AND i.created_at >= ?`).get(steamId, since) as Row).n);
  }

  expiredReportImages(before: number): { id: number; file: string }[] {
    return this.prep(`SELECT i.id, i.file FROM report_images i
      LEFT JOIN reports r ON r.id = i.report_id AND r.server_id = i.server_id
      WHERE r.id IS NULL OR (r.status != 'open' AND r.handled_at < ?)`).all(before) as { id: number; file: string }[];
  }

  reportImageFiles(): Set<string> {
    return new Set((this.prep('SELECT file FROM report_images').all() as Row[]).map((r) => String(r.file)));
  }

  deleteReportImage(id: number): void {
    this.prep('DELETE FROM report_images WHERE id = ?').run(id);
  }

  reportById(id: number): Report | null {
    return (this.prep(`SELECT ${REPORT_COLUMNS} FROM reports WHERE id = ?`).get(id) as Report | undefined) ?? null;
  }

  reportImageIds(reportIds: number[]): Map<number, number[]> {
    const out = new Map<number, number[]>();
    if (!reportIds.length) return out;
    const rows = this.prep(`SELECT id, report_id AS reportId FROM report_images WHERE report_id IN (${reportIds.map(() => '?').join(',')}) ORDER BY id`)
      .all(...reportIds) as { id: number; reportId: number }[];
    for (const r of rows) out.set(r.reportId, [...(out.get(r.reportId) ?? []), r.id]);
    return out;
  }

  reportsByReporter(steamId: string, { since = 0, limit = 50 } = {}): (Report & { serverName: string | null })[] {
    return this.prep(`SELECT r.*, (SELECT name FROM servers WHERE id = r.serverId) AS serverName
      FROM (SELECT ${REPORT_COLUMNS} FROM reports
        WHERE reporter_steam_id = ? AND reporter_discord_id IS NULL AND created_at >= ? ORDER BY id DESC LIMIT ?) r`)
      .all(steamId, since, limit) as Row[] as (Report & { serverName: string | null })[];
  }

  reportCountByDiscord(discordId: string, since: number): number {
    return Number((this.prep('SELECT COUNT(*) AS n FROM reports WHERE reporter_discord_id = ? AND created_at >= ?').get(discordId, since) as Row).n);
  }

  logFeedRequest(serverId: number | null, r: FeedRequest): void {
    const id = Number(this.prep(`INSERT INTO feed_requests (server_id, at, peer, status, code, events, accepted, duplicates, error)
      VALUES (:sid, :at, :peer, :status, :code, :events, :accepted, :duplicates, :error)`).run({
      sid: serverId, at: r.at, peer: r.peer ?? null, status: r.status, code: r.code ?? null, events: r.events ?? null,
      accepted: r.accepted ?? null, duplicates: r.duplicates ?? null, error: r.error ? String(r.error).slice(0, 200) : null,
    }).lastInsertRowid);
    if (id % 100 === 0) {
      this.prep(`DELETE FROM feed_requests WHERE server_id IS :sid AND id <= COALESCE(
        (SELECT id FROM feed_requests WHERE server_id IS :sid ORDER BY id DESC LIMIT 1 OFFSET :keep), 0)`).run({ sid: serverId, keep: FEED_REQUEST_KEEP });
    }
  }

}

export class ServerStore {
  root: Store;
  id: number;

  constructor(root: Store, id: number) {
    this.root = root;
    this.id = id;
  }

  #get(sql: string, ...args: any[]): Row | undefined {
    return this.root.prep(sql).get(this.id, ...args) as Row | undefined;
  }

  #all(sql: string, ...args: any[]): Row[] {
    return this.root.prep(sql).all(this.id, ...args) as Row[];
  }

  #run(sql: string, ...args: any[]) {
    return this.root.prep(sql).run(this.id, ...args);
  }

  #setting<T>(key: string, fallback: T): T {
    const row = this.#get('SELECT value FROM server_settings WHERE server_id = ? AND key = ?', key);
    return row ? JSON.parse(row.value) : fallback;
  }

  #setSetting(key: string, value: unknown): void {
    this.#run(`INSERT INTO server_settings (server_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value`, key, JSON.stringify(value));
  }

  hasKill(eventId: string): boolean {
    return !!this.#get('SELECT 1 FROM kills WHERE server_id = ? AND event_id = ?', eventId);
  }

  lastKill(): Kill | null {
    const r = this.#get('SELECT * FROM kills WHERE server_id = ? ORDER BY received_at DESC LIMIT 1');
    return r ? rowToKill(r) : null;
  }

  lastMatchPlayer(): MatchPlayerSeen | null {
    return (this.#get(`SELECT match_key AS matchKey, map, last_seen AS lastSeen
      FROM match_players WHERE server_id = ? ORDER BY last_seen DESC LIMIT 1`) as MatchPlayerSeen | undefined) ?? null;
  }

  insertKill(k: Kill): boolean {
    const r = this.root.prep(`INSERT OR IGNORE INTO kills
      (server_id, event_id, received_at, match_key, map, event_time, killer_steam, killer_name, killer_faction,
       victim_steam, victim_name, victim_faction, cause, weapon, distance_m, tags, headshot, suicide, teamkill, engagement_id)
      VALUES (:sid, :eventId, :receivedAt, :matchKey, :map, :eventTime, :killerSteamId, :killerName, :killerFaction,
       :victimSteamId, :victimName, :victimFaction, :cause, :weapon, :distanceM, :tags, :headshot, :suicide, :teamkill, :engagementId)`).run({
      ...k,
      sid: this.id,
      tags: JSON.stringify(k.tags),
      headshot: k.headshot ? 1 : 0,
      suicide: k.suicide ? 1 : 0,
      teamkill: k.teamkill ? 1 : 0,
    });
    return r.changes > 0;
  }

  insertMatchEvent(e: MatchEvent, receivedAt: number): boolean {
    const r = this.#run(`INSERT OR IGNORE INTO match_events
      (server_id, event_id, received_at, type, map, event_time, match_id, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    e.eventId, receivedAt, e.type, e.mapName ?? null, e.eventTime ?? null, e.matchId ?? null, JSON.stringify(e));
    return r.changes > 0;
  }

  createEngagement(matchKey: string | null, map: string | null, at: number, eventTime: number | null): number {
    return Number(this.#run(`INSERT INTO engagements (server_id, match_key, map, started_at, ended_at, start_time, end_time)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, matchKey, map, at, at, eventTime, eventTime).lastInsertRowid);
  }

  saveEngagement(e: OpenEngagement): void {
    this.root.prep(`UPDATE engagements SET ended_at = :endedAt, end_time = :endTime, kills = :kills,
      headshots = :headshots, teamkills = :teamkills, distance_sum = :distanceSum, distance_n = :distanceN,
      factions = :factions, participants = :participants, weapons = :weapons WHERE id = :id AND server_id = :sid`).run({
      sid: this.id,
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
    this.#run('INSERT INTO actions (server_id, at, actor, action, target, detail, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      at, actor, action, target ?? null, detail ? JSON.stringify(detail) : null, ok ? 1 : 0, error ?? null);
    return { at, actor, action, target, detail, ok, error };
  }

  seePlayer(steamId: string, name: string | null, now: number, newSession: boolean, recordName: boolean): void {
    this.#run(`INSERT INTO players (server_id, steam_id, first_seen, last_seen, last_name, sessions)
      VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(server_id, steam_id) DO UPDATE SET last_seen = excluded.last_seen, last_name = excluded.last_name,
        sessions = sessions + ?`, steamId, now, now, name, newSession ? 1 : 0);
    if (recordName && name != null) {
      this.#run(`INSERT INTO player_names (server_id, steam_id, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(server_id, steam_id, name) DO UPDATE SET last_seen = excluded.last_seen`, steamId, name, now, now);
    }
  }

  addMatchPlayers(rows: MatchPlayerDelta[]): void {
    if (!rows.length) return;
    const stmt = this.root.prep(`INSERT INTO match_players
      (server_id, match_key, steam_id, map, faction, kills, deaths, cash_peak, cash_earned, first_seen, last_seen)
      VALUES (:sid, :matchKey, :steamId, :map, :faction, :kills, :deaths, :cashPeak, :earned, :at, :at)
      ON CONFLICT(server_id, match_key, steam_id) DO UPDATE SET
        map = COALESCE(excluded.map, map),
        faction = COALESCE(excluded.faction, faction),
        kills = kills + excluded.kills,
        deaths = deaths + excluded.deaths,
        cash_peak = CASE WHEN cash_peak IS NULL THEN excluded.cash_peak
          WHEN excluded.cash_peak IS NULL THEN cash_peak ELSE MAX(cash_peak, excluded.cash_peak) END,
        cash_earned = cash_earned + excluded.cash_earned,
        last_seen = excluded.last_seen`);
    this.root.tx(() => {
      for (const r of rows) stmt.run({ ...r, sid: this.id });
    });
  }

  setMatchResult(matchKey: string, winningFaction: string | null | undefined, at: number): void {
    this.#run(`INSERT INTO match_results (server_id, match_key, winning_faction, ended_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(server_id, match_key) DO UPDATE SET winning_faction = excluded.winning_faction, ended_at = excluded.ended_at`,
    matchKey, winningFaction || null, at);
  }

  addReport(r: NewReport): Report {
    const { lastInsertRowid } = this.#run(`INSERT INTO reports
      (server_id, created_at, reporter_chzzk_id, reporter_chzzk_name, reporter_steam_id, reporter_steam_name,
       reporter_discord_id, reporter_discord_name, target_name, target_steam_id, category, description, evidence_url, map)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, r.createdAt, r.reporterChzzkId, r.reporterChzzkName,
    r.reporterSteamId, r.reporterSteamName, r.reporterDiscordId, r.reporterDiscordName, r.targetName, r.targetSteamId, r.category, r.description, r.evidenceUrl, r.map);
    return this.report(Number(lastInsertRowid))!;
  }

  addReportImage(reportId: number, file: string, mime: string, size: number, at: number): number {
    return Number(this.#run('INSERT INTO report_images (server_id, report_id, file, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      reportId, file, mime, size, at).lastInsertRowid);
  }

  hasPlayed(steamId: string): boolean {
    return !!this.#get('SELECT 1 FROM players WHERE server_id = ? AND steam_id = ?', steamId);
  }

  reportImageCount(reportId: number): number {
    return Number(this.#get('SELECT COUNT(*) AS n FROM report_images WHERE server_id = ? AND report_id = ?', reportId)!.n);
  }

  reportImageOf(reportId: number, imageId: number): ReportImage | null {
    return (this.#get(`SELECT id, report_id AS reportId, file, mime, size, created_at AS createdAt
      FROM report_images WHERE server_id = ? AND report_id = ? AND id = ?`, reportId, imageId) as ReportImage | undefined) ?? null;
  }

  report(id: number): Report | null {
    return (this.#get(`SELECT ${REPORT_COLUMNS} FROM reports WHERE server_id = ? AND id = ?`, id) as Report | undefined) ?? null;
  }

  reports({ status, limit = 200 }: { status?: string; limit?: number } = {}): Report[] {
    return this.#all(`SELECT ${REPORT_COLUMNS} FROM reports WHERE server_id = ? AND (? IS NULL OR status = ?)
      ORDER BY id DESC LIMIT ?`, status ?? null, status ?? null, limit) as Report[];
  }

  updateReport(id: number, status: string, note: string | null, by: string, at: number): Report | null {
    this.root.prep('UPDATE reports SET status = ?, note = ?, handled_by = ?, handled_at = ? WHERE server_id = ? AND id = ?')
      .run(status, note, by, at, this.id, id);
    return this.report(id);
  }

  steamIdByName(name: string): string | null {
    return this.#get('SELECT steam_id FROM player_names WHERE server_id = ? AND name = ? ORDER BY last_seen DESC LIMIT 1', name)?.steam_id ?? null;
  }

  recentKills({ limit = 100, before, search }: { limit?: number; before?: number; search?: string } = {}): Kill[] {
    const where = ['server_id = :sid'];
    const args: Record<string, string | number> = { sid: this.id };
    if (before) { where.push('received_at < :before'); args.before = before; }
    if (search) {
      where.push('(killer_name LIKE :s OR victim_name LIKE :s OR weapon LIKE :s OR cause LIKE :s OR killer_steam = :raw OR victim_steam = :raw)');
      args.s = `%${search}%`;
      args.raw = search;
    }
    args.limit = Math.min(limit, 500);
    const sql = `SELECT * FROM kills WHERE ${where.join(' AND ')} ORDER BY received_at DESC, event_time DESC LIMIT :limit`;
    return this.root.prep(sql).all(args).map(rowToKill);
  }

  recentEngagements({ limit = 30, minKills = 1 } = {}): Engagement[] {
    return this.#all('SELECT * FROM engagements WHERE server_id = ? AND kills >= ? ORDER BY started_at DESC LIMIT ?', minKills, limit)
      .map(rowToEngagement);
  }

  engagementKills(id: number): Kill[] {
    return this.#all('SELECT * FROM kills WHERE server_id = ? AND engagement_id = ? ORDER BY received_at, event_time', id).map(rowToKill);
  }

  matchStats(matchKey: string | null) {
    if (!matchKey) return [];
    return this.#all(`
      SELECT killer_steam AS steamId, COUNT(*) AS kills, SUM(headshot) AS headshots, SUM(teamkill) AS teamkills,
             MAX(distance_m) AS maxDistance
      FROM kills WHERE server_id = ? AND match_key = ? AND killer_steam IS NOT NULL AND suicide = 0
      GROUP BY killer_steam`, matchKey);
  }

  weaponStats({ since = 0, limit = 30 } = {}) {
    return this.#all(`
      SELECT weapon, COUNT(*) AS kills, SUM(headshot) AS headshots, AVG(distance_m) AS avgDistance, MAX(distance_m) AS maxDistance
      FROM kills WHERE server_id = ? AND received_at >= ? AND weapon IS NOT NULL AND suicide = 0
      GROUP BY weapon ORDER BY kills DESC LIMIT ?`, since, limit);
  }

  recentMatchEvents(limit = 50): (MatchEvent & { receivedAt: number })[] {
    return this.#all('SELECT * FROM match_events WHERE server_id = ? ORDER BY received_at DESC LIMIT ?', limit)
      .map((r) => ({ ...JSON.parse(r.payload), receivedAt: r.received_at }));
  }

  logFeedRequest(r: FeedRequest): void {
    this.root.logFeedRequest(this.id, r);
  }

  feedRequests(limit = 300) {
    return this.#all('SELECT * FROM feed_requests WHERE server_id = ? ORDER BY id DESC LIMIT ?', limit);
  }

  feedEvents(limit = 300) {
    const kills = this.recentKills({ limit }).map((k) => ({ type: 'killed', ...k }));
    return [...kills, ...this.recentMatchEvents(limit)].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, limit);
  }

  actions({ limit = 200 } = {}): Action[] {
    return this.#all('SELECT * FROM actions WHERE server_id = ? ORDER BY at DESC LIMIT ?', limit)
      .map((r) => ({ ...r, ok: !!r.ok, detail: r.detail ? JSON.parse(r.detail) : null }) as Action);
  }

  playerProfile(steamId: string) {
    const p = this.#get('SELECT * FROM players WHERE server_id = ? AND steam_id = ?', steamId);
    const names = this.#all('SELECT name, first_seen, last_seen FROM player_names WHERE server_id = ? AND steam_id = ? ORDER BY last_seen DESC', steamId);
    const totals = this.root.prep(`SELECT
        SUM(CASE WHEN killer_steam = :s AND suicide = 0 THEN 1 ELSE 0 END) AS kills,
        SUM(CASE WHEN victim_steam = :s THEN 1 ELSE 0 END) AS deaths,
        SUM(CASE WHEN killer_steam = :s AND headshot = 1 AND suicide = 0 THEN 1 ELSE 0 END) AS headshots,
        SUM(CASE WHEN killer_steam = :s AND teamkill = 1 THEN 1 ELSE 0 END) AS teamkills
      FROM kills WHERE server_id = :sid AND (killer_steam = :s OR victim_steam = :s)`).get({ s: steamId, sid: this.id });
    const weapons = this.#all(`SELECT weapon, COUNT(*) AS kills FROM kills
      WHERE server_id = ? AND killer_steam = ? AND suicide = 0 GROUP BY weapon ORDER BY kills DESC LIMIT 8`, steamId);
    return { player: p ?? null, names, totals, weapons };
  }

  pendingBans(): PendingBan[] {
    return this.#all('SELECT steam_id, reason, created_at, created_by, last_error FROM pending_bans WHERE server_id = ? ORDER BY created_at DESC') as PendingBan[];
  }

  addPendingBan(steamId: string, reason: string | null, by: string): void {
    this.#run(`INSERT INTO pending_bans (server_id, steam_id, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_id, steam_id) DO UPDATE SET reason = excluded.reason`, steamId, reason ?? null, Date.now(), by);
  }

  removePendingBan(steamId: string): boolean {
    return this.#run('DELETE FROM pending_bans WHERE server_id = ? AND steam_id = ?', steamId).changes > 0;
  }

  notePendingBanError(steamId: string, error: string): void {
    this.root.prep('UPDATE pending_bans SET last_error = ? WHERE server_id = ? AND steam_id = ?').run(error, this.id, steamId);
  }

  links(): LinkWithSeen[] {
    return this.#all(`SELECT ${LINK_COLUMNS}, p.last_name AS lastName, p.last_seen AS lastSeen
      FROM account_links a LEFT JOIN players p ON p.server_id = ? AND p.steam_id = a.steam_id
      ORDER BY a.linked_at DESC`).map((r) => ({ ...rowToLink(r), lastName: r.lastName, lastSeen: r.lastSeen }));
  }

  linkByAccount(provider: 'chzzk' | 'steam', id: string): Link | null {
    return this.root.linkByAccount(provider, id);
  }

  linksBySteam(steamIds: string[]): Map<string, Link> {
    return this.root.linksBySteam(steamIds);
  }

  discordLink(by: 'discord' | 'steam', id: string): DiscordLink | null {
    const col = by === 'discord' ? 'discord_id' : 'steam_id';
    const r = this.#get(`SELECT ${DISCORD_COLUMNS} FROM discord_links WHERE server_id = ? AND ${col} = ?`, id);
    return r ? rowToDiscordLink(r) : null;
  }

  discordLinks(): DiscordLink[] {
    return this.#all(`SELECT ${DISCORD_COLUMNS} FROM discord_links WHERE server_id = ? ORDER BY linked_at DESC`).map(rowToDiscordLink);
  }

  discordLinksBySteam(steamIds: string[]): Map<string, DiscordLink> {
    if (!steamIds.length) return new Map();
    const rows = this.#all(`SELECT ${DISCORD_COLUMNS} FROM discord_links
      WHERE server_id = ? AND steam_id IN (SELECT value FROM json_each(?))`, JSON.stringify(steamIds));
    return new Map(rows.map((r) => [r.steamId, rowToDiscordLink(r)]));
  }

  saveDiscordLink(discordId: string, discordName: string, link: StreamerPair, at: number): void {
    this.#run(`INSERT INTO discord_links (server_id, discord_id, discord_name, steam_id, steam_name, chzzk_channel_id, chzzk_name, linked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, discord_id) DO UPDATE SET discord_name = excluded.discord_name, steam_name = excluded.steam_name,
        chzzk_channel_id = excluded.chzzk_channel_id, chzzk_name = excluded.chzzk_name, linked_at = excluded.linked_at,
        reserved = CASE WHEN steam_id = excluded.steam_id THEN reserved ELSE 0 END,
        last_error = CASE WHEN steam_id = excluded.steam_id THEN last_error ELSE NULL END,
        steam_id = excluded.steam_id`, discordId, discordName, link.steamId, link.steamName, link.chzzkChannelId, link.chzzkName, at);
  }

  removeDiscordLink(discordId: string): void {
    this.#run('DELETE FROM discord_links WHERE server_id = ? AND discord_id = ?', discordId);
  }

  markDiscordReserved(steamId: string, error: string | null): void {
    this.root.prep('UPDATE discord_links SET reserved = ?, last_error = ? WHERE server_id = ? AND steam_id = ?').run(error ? 0 : 1, error, this.id, steamId);
  }

  discordReleases(): string[] {
    return this.#all('SELECT steam_id FROM discord_releases WHERE server_id = ? ORDER BY created_at').map((r) => r.steam_id);
  }

  addDiscordRelease(steamId: string): void {
    this.#run('INSERT OR IGNORE INTO discord_releases (server_id, steam_id, created_at) VALUES (?, ?, ?)', steamId, Date.now());
  }

  removeDiscordRelease(steamId: string): void {
    this.#run('DELETE FROM discord_releases WHERE server_id = ? AND steam_id = ?', steamId);
  }

  whitelist(): Whitelist {
    const { subscribers, ...v } = this.#setting<Partial<Whitelist> & { subscribers?: boolean }>('whitelist', {});
    return { ...WHITELIST_DEFAULT, ...(subscribers ? { audience: 'subscriber' as const } : {}), ...v };
  }

  setWhitelist(value: Whitelist): void {
    this.#setSetting('whitelist', value);
  }

  entryGate(): EntryGate {
    return { ...ENTRY_GATE_DEFAULT, ...this.#setting('entry_gate', {}) };
  }

  setEntryGate(value: EntryGate): void {
    this.#setSetting('entry_gate', value);
  }

  turnover(): Turnover {
    return { ...TURNOVER_DEFAULT, ...this.#setting('turnover', {}) };
  }

  setTurnover(value: Turnover): void {
    this.#setSetting('turnover', value);
  }

  configPresets(): ConfigPreset[] {
    return this.#setting('config_presets', []);
  }

  setConfigPresets(list: ConfigPreset[]): void {
    this.#setSetting('config_presets', list);
  }

  chzzkOwner(): ChzzkOwner | null {
    const o = this.#setting<ChzzkOwner | null>('chzzk_owner', null);
    return o && { ...o, accessToken: this.root.openSecret(o.accessToken), refreshToken: this.root.openSecret(o.refreshToken) };
  }

  setChzzkOwner(o: ChzzkOwner | null): void {
    if (!o) return void this.#run('DELETE FROM server_settings WHERE server_id = ? AND key = ?', 'chzzk_owner');
    this.#setSetting('chzzk_owner', { ...o, accessToken: this.root.sealSecret(o.accessToken), refreshToken: this.root.sealSecret(o.refreshToken) });
  }

  replaceAudience(kind: ChzzkAudience, channelIds: string[]): void {
    const table = AUDIENCE_TABLE[kind];
    this.root.tx(() => {
      this.#run(`DELETE FROM ${table} WHERE server_id = ?`);
      for (const id of new Set(channelIds)) this.#run(`INSERT INTO ${table} (server_id, channel_id) VALUES (?, ?)`, id);
    });
  }

  audienceOf(kind: ChzzkAudience, channelIds: string[]): Set<string> {
    if (!channelIds.length) return new Set();
    const tables = kind === 'follower' ? ['chzzk_followers', 'chzzk_subscribers'] : ['chzzk_subscribers'];
    const source = tables.map((t) => `SELECT server_id, channel_id FROM ${t}`).join(' UNION ALL ');
    return new Set(this.#all(`SELECT channel_id FROM (${source}) WHERE server_id = ? AND channel_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(channelIds)).map((r) => r.channel_id));
  }

  passes(chzzkChannelId: string): boolean {
    const { audience } = this.whitelist();
    return audience === 'linked' || this.audienceOf(audience, [chzzkChannelId]).size > 0;
  }

  whitelistBans(): WhitelistBan[] {
    const { audience } = this.whitelist();
    const inAudience = audience === 'linked' ? '1'
      : audience === 'follower' ? '(s.channel_id IS NOT NULL OR f.channel_id IS NOT NULL)' : 's.channel_id IS NOT NULL';
    return this.root.prep(`SELECT w.steam_id AS steamId, w.name, w.created_at AS createdAt, w.last_error AS lastError,
        (d.steam_id IS NOT NULL OR (a.steam_id IS NOT NULL AND ${inAudience})) AS linked
      FROM whitelist_bans w LEFT JOIN account_links a ON a.steam_id = w.steam_id
      LEFT JOIN discord_links d ON d.server_id = w.server_id AND d.steam_id = w.steam_id
      LEFT JOIN chzzk_subscribers s ON s.server_id = w.server_id AND s.channel_id = a.chzzk_channel_id
      LEFT JOIN chzzk_followers f ON f.server_id = w.server_id AND f.channel_id = a.chzzk_channel_id
      WHERE w.server_id = ?
      ORDER BY w.created_at DESC`).all(this.id).map((r) => ({ ...r, linked: !!r.linked }) as WhitelistBan);
  }

  addWhitelistBan(steamId: string, name: string | null | undefined): void {
    this.#run(`INSERT INTO whitelist_bans (server_id, steam_id, name, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(server_id, steam_id) DO UPDATE SET last_error = NULL`, steamId, name ?? null, Date.now());
  }

  removeWhitelistBan(steamId: string): void {
    this.#run('DELETE FROM whitelist_bans WHERE server_id = ? AND steam_id = ?', steamId);
  }

  noteWhitelistBanError(steamId: string, error: string): void {
    this.root.prep('UPDATE whitelist_bans SET last_error = ? WHERE server_id = ? AND steam_id = ?').run(error, this.id, steamId);
  }
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

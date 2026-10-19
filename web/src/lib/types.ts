// JSON shapes the dashboard API sends. They mirror server/ but as they arrive over the wire
// (Sets become arrays, timestamps are epoch milliseconds).

export type Role = 'viewer' | 'mod' | 'admin';

// A fetched value, or the error message shown in its place. `x.error` narrows either way.
export type OrError<T> = (T & { error?: undefined }) | { error: string };

export interface Me {
  name: string;
  role: Role;
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

export interface LinkRow extends Link {
  lastName: string | null;
  lastSeen: number | null;
}

export interface Player {
  steamId: string;
  name: string;
  faction?: string;
  kills: number;
  deaths: number;
  cash?: number;
  pingMs: number;
  joinedAt: number | null;
  link: Link | null;
}

export interface FactionScore {
  name: string;
  score: number;
  colorHex?: string;
}

export interface GameStatus {
  serverName?: string;
  map?: string;
  lighting?: string;
  experiences?: string[];
  players: { current: number; max: number };
  factionScores?: FactionScore[];
}

export interface FeedStatus {
  serverName: string | null;
  lastBatchAt: number | null;
  batches: number;
  rejected: number;
  matchKey: string | null;
  map: string | null;
  lastEventTime: number | null;
  matchState: { state?: string; at: number; eventTime: number | null } | null;
}

export interface MatchStat {
  steamId: string;
  kills: number;
  headshots: number;
  teamkills: number;
  maxDistance: number | null;
}

export interface Live {
  online: boolean;
  lastError: { code?: string; message: string; at: number } | null;
  lastPollAt: number | null;
  intervalMs: number;
  status: GameStatus | null;
  players: Player[];
  health: { gameThreadQueue?: { depth?: number; rejectedTotal?: number } } | null;
  restart: { uptimeSeconds: number; due: boolean } | null;
  match: { scoreCap: number | null; scoreCapAssumed: boolean; matchSeconds: number | null; matchSecondsSource: 'status' | 'feed' | null } | null;
  mapTransition: boolean;
  cashUnreliable: boolean;
  serverId: string | null;
  feed: FeedStatus;
  gameFeed: { enabled: boolean; endpointCount: number; anyUnhealthy: boolean } | null;
  matchStats: MatchStat[];
}

export interface Capabilities {
  apiVersion?: string;
  build?: string;
  limits?: { maxRequestsPerMinutePerIp?: number; maxBodyBytes?: number };
  config?: { writable?: boolean };
  routes: string[];
  features: { changeTeam: boolean; feed: boolean; reservedRoutes: boolean; configDocument: boolean };
  version: { build: string | null; project: { name?: string; version?: string } } | null;
}

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

// Match events as the game sends them, plus kills when listed alongside them (type 'killed').
export interface FeedEvent extends Partial<Omit<Kill, 'receivedAt'>> {
  type: string;
  receivedAt: number;
  mapName?: string;
  playerName?: string;
  players?: number;
  state?: string;
  winningFaction?: string;
  factionScores?: { faction: string; score: number }[];
}

export interface ActionDetail {
  name?: string;
  reason?: string;
  message?: string;
  faction?: string;
  map?: string;
  via?: string;
  queuedBy?: string;
}

export interface Action {
  id?: number;
  at: number;
  actor: string;
  action: string;
  target: string | null;
  detail: ActionDetail | null;
  ok: boolean;
  error?: string | null;
}

export interface Ban {
  steamId: string;
  bannedAtUtc?: string;
  bannedBy?: string;
  reason?: string;
}

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

export type WhitelistMode = 'off' | 'kick' | 'ban';

export interface Whitelist {
  mode: WhitelistMode;
  message: string;
  bans: WhitelistBan[];
}

export interface CatalogItem {
  id: string;
  displayName?: string;
}

export interface Catalog {
  maps: CatalogItem[];
  lightings: CatalogItem[];
  experiences: CatalogItem[];
}

export interface MapOptions {
  experiences: string[];
  alternators: { tag: string; displayName?: string }[];
}

export interface Rotation {
  enabled?: boolean;
  mode?: string;
  entries?: { index?: number; map: string; experiences?: string[]; lighting?: string; status?: string; denied?: boolean }[];
}

export interface ScorePeriod {
  saved: number | null;
  current: number | null;
  range: [number, number];
}

export interface ConfigDoc {
  revision: string;
  writable: boolean;
  text: string;
  sections: { section: string; keyOverrides?: { key: string; writable?: boolean; lockedBy?: string }[] }[];
  warnings: unknown[];
}

export interface ConfigResult {
  ok: boolean;
  status: number;
  revision?: string;
  errors?: { section?: string; key?: string; message?: string; code?: string }[];
  changed?: { section: string; removed?: boolean; added?: boolean; keys?: string[] }[];
  outcomes?: { section: string; state: string; detail?: string }[];
  shadowed?: unknown[];
  stripped?: unknown[];
  warnings?: unknown[];
}

export interface FeedRequestRow {
  id: number;
  at: number;
  peer: string | null;
  status: number;
  code: string | null;
  events: number | null;
  accepted: number | null;
  duplicates: number | null;
  error: string | null;
}

export interface Audit {
  dashboard: Action[];
  rcon: { timestampUtc: string; event: string; peer?: string; detail?: string }[] | null;
  rconError: string | null;
  feedRequests: FeedRequestRow[];
  feedEvents: FeedEvent[];
}

export interface PlayerProfile {
  player: { first_seen: number; sessions: number } | null;
  names: { name: string }[];
  totals: { kills?: number; deaths?: number; headshots?: number; teamkills?: number };
  weapons: { weapon: string; kills: number }[];
}

export interface WeaponStat {
  weapon: string;
  kills: number;
  headshots: number;
  avgDistance: number | null;
  maxDistance: number | null;
}

export interface PublicLive {
  online: boolean;
  serverName: string | null;
  map: string | null;
  playerCount: number;
  maxPlayers: number | null;
  factionScores: FactionScore[];
  scoreCap: number | null;
  matchState: string | null;
  players: { channelId: string; name: string | null; faction: string | null; kills: number; deaths: number; cash: number | null }[];
  updatedAt: number | null;
}

export interface LeaderboardRow {
  channelId: string;
  name: string | null;
  matches: number;
  kills: number;
  deaths: number;
  kd: number;
  cashEarned: number;
  cashPeak: number | null;
  wins: number;
  decided: number;
  winRate: number | null;
  headshots: number;
  headshotRate: number | null;
  feedKills: number;
  longest: number | null;
  lastSeen: number;
}

export interface Leaderboard {
  period: string;
  since: number;
  updatedAt: number;
  minimums: { kd: number; headshotRate: number; winRate: number };
  rows: LeaderboardRow[];
}

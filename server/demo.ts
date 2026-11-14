import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RconClient, RconError } from './rcon.ts';
import { FeedProcessor } from './feed.ts';
import { CASH_SAMPLE_MS } from './poller.ts';
import { getValue, parseRotationEntry, rotationEntriesInDoc, reservedIdsInDoc, setReservedInDoc, sameSelection, S_SESSION, S_ENGINE, S_PREMATCH, S_KOTH, S_STATE, S_ROTATION, S_RCON, S_AFK, type RotationEntry } from './inidoc.ts';
import type { Store, ServerRow, MatchPlayerDelta } from './store.ts';
import type { WeaponLookup } from './weapons.ts';
import type { Fleet } from './fleet.ts';

const DEMO_PREFIX = 'demo://';
const isDemoUrl = (url: string | null | undefined) => !!url?.startsWith(DEMO_PREFIX);

const REAL_STEAM_MIN = '76561197960265728';
export const isDemoSteamId = (id: string) => id.length === 17 && id < REAL_STEAM_MIN;
const demoId = (official: string) => `76561197${official.slice(8)}`;
const remapIds = (text: string) => text.replace(/765611980\d{8}|765611981\d{8}|765611982\d{8}/g, demoId);
export const GUEST_STEAM_ID = '76561197000000000';
export const GUEST_NAME = '데모 체험';

const RESET_MS = 6 * 3600_000;
const HISTORY_MS = 6 * 3600_000;
const HISTORY_STEP_SEC = 3;
const LIVE_STEP_MS = 2000;
const POST_MATCH_SEC = 25;
const SCORE_SPEED = 0.1;
const KICK_REJOIN_MS = 90_000;
const ONLINE_TARGET = 16;
const OFFICIAL_MATCH_SECONDS = 105 * 60 + 12;

const FACTIONS = [
  { name: 'Valkyra', label: 'RED', colorHex: '#D86060' },
  { name: 'Lonestar', label: 'BLU', colorHex: '#5B95D8' },
  { name: 'Manticore', label: 'GRN', colorHex: '#7BC462' },
];
const factionName = (label: string | null) => FACTIONS.find((f) => f.label === label)?.name ?? null;

const MAPS = [
  { id: 'Kavkazi', displayName: 'Bakurani' },
  { id: 'Europe', displayName: 'Ozeti' },
  { id: 'NorthAmerica', displayName: 'Zestafona' },
  { id: 'Russia', displayName: 'Sabatulo' },
];
const EXPERIENCES = [
  { id: 'Bakurani_KOTH_01', displayName: 'King of the Hill' },
  { id: 'Madrid_KOTH_01', displayName: 'King of the Hill' },
  { id: 'Detroit_KOTH_01', displayName: 'King of the Hill' },
  { id: 'Moscow_KOTH_01', displayName: 'King of the Hill' },
  { id: 'KOTH_InfantryOnly', displayName: 'Infantry' },
  { id: 'KOTH_Hardcore', displayName: 'Hardcore' },
  { id: 'KOTH_LimitedGear', displayName: 'Limited Gear' },
];
const EXPERIENCES_BY_MAP: Record<string, string[]> = {
  Kavkazi: ['Bakurani_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_Hardcore', 'KOTH_LimitedGear'],
  Europe: ['Madrid_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_Hardcore', 'KOTH_LimitedGear'],
  NorthAmerica: ['Detroit_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_Hardcore', 'KOTH_LimitedGear'],
  Russia: ['Moscow_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_Hardcore', 'KOTH_LimitedGear'],
};
const LIGHTINGS = [
  { id: 'DayStartClear', displayName: 'Day Start Clear' },
  { id: 'DayEarlyClear', displayName: 'Day Early Clear' },
  { id: 'DayEarlyFog', displayName: 'Day Early Fog' },
  { id: 'DayClear', displayName: 'Day Clear' },
  { id: 'DayLateClear', displayName: 'Day Late Clear' },
  { id: 'DayLateGray', displayName: 'Day Late Gray' },
  { id: 'DayLateGrayFog', displayName: 'Day Late Gray Fog' },
  { id: 'DayLateRain', displayName: 'Day Late Rain' },
  { id: 'DayEndClear', displayName: 'Day End Clear' },
];
const ALTERNATORS_BY_MAP: Record<string, { tag: string; displayName: string }[]> = {
  Kavkazi: [
    { tag: 'ZoneAlternator.Factory.Circle', displayName: 'Bakurani Factory Circle' },
    { tag: 'ZoneAlternator.Factory.Split', displayName: 'Bakurani Factory Split' },
  ],
};
const UNKNOWN_NAMES = ['스나이퍼', '텀블러', '알파벳', '악마', '쥬쥬', '아이스', '연봉', '썩은물', '인공눈물', '누누', '매니큐어', '악몽'];

const SESSION_JOIN_NOTE = 'Sent on the session update this apply triggers, so new joins are checked against it at once. Players already connected are not re-checked or removed.';
const CONFIG_SECTIONS = [
  { section: S_SESSION, appliesWhen: 'applied', description: 'Server identity, bans, reserved slots and the sponsor banner.',
    keyOverrides: [
      { key: 'ServerPassword', appliesWhen: 'applied', description: 'Sent on the session update this apply triggers, so it gates new joins at once. Players already in are not rechecked.' },
      { key: 'ServerImageURL', appliesWhen: 'pending', description: 'Fetched and validated off-thread before the banner is advertised.' },
      ...['ServerMinPlayerCash', 'ServerMaxPlayerCash', 'ServerMinPlayerLevel', 'ServerMaxPlayerLevel'].map((key) => ({ key, appliesWhen: 'applied', description: SESSION_JOIN_NOTE })),
    ] },
  { section: S_ENGINE, appliesWhen: 'next-restart', description: 'Player slot count. Not applied to a running server by choice, so a change takes effect on restart.', keyOverrides: [] },
  { section: S_STATE, appliesWhen: 'next-match', description: 'Team balance rules and the welcome message. The running match keeps its current values; the config values are read when a match starts.',
    keyOverrides: [
      { key: 'ServerWelcomeMessageLines', appliesWhen: 'next-match', description: 'Welcome popup lines, shown once when a player first deploys. Up to 128 lines of 128 visible characters, scrolling when taller than the popup; style with <Bold>, <Italic>, <Header> or <text color="#RRGGBB" size="8-24" fontface="Bold">. Links and other tags show as typed.' },
      { key: 'bServerWelcomeMessageEnabled', appliesWhen: 'next-match', description: 'Shows the welcome popup from the next match.' },
      { key: 'ServerWelcomeMessageCloseDelaySeconds', appliesWhen: 'next-match', description: "Seconds the welcome popup's Close button stays locked so players read it first. 0 = no lock, up to 60." },
      { key: 'bServerWelcomeMessageSkipForStreamers', appliesWhen: 'next-match', description: 'Players with streamer mode on skip the welcome popup.' },
    ] },
  { section: S_ROTATION, appliesWhen: 'applied', description: 'Map rotation order and mode. Rebuilt immediately; used from the next map change.', keyOverrides: [] },
  { section: S_KOTH, appliesWhen: 'next-match', description: 'KOTH scoring. Scoring cadence never changes mid-round.', keyOverrides: [] },
  { section: S_PREMATCH, appliesWhen: 'next-match', description: 'Minimum players before a match starts. Read when the next pre-match begins.', keyOverrides: [] },
  { section: S_RCON, appliesWhen: 'next-restart', description: 'RCON listener. Written now, read at startup.', keyOverrides: [] },
  { section: S_AFK, appliesWhen: 'next-match', description: "AFK kick timeout. Each player's AFK check reads it when the match starts, so a change applies from the next match.", keyOverrides: [] },
];

const SERVER_SETTINGS_INI = readFileSync(new URL('./assets/ServerSettings.ini', import.meta.url), 'utf8');

interface OfficialPlayer {
  name: string;
  steamId: string | null;
  faction: string | null;
  kills: number;
  deaths: number;
  cash: number;
  ping: number;
}

interface Profile {
  key: string;
  label: string;
  config: string;
  scoreRates: number[];
  initialScores: number[];
  players: OfficialPlayer[];
  joiners: string[];
  joinerIdBase: bigint;
  bans: { steamId: string; bannedAtUtc: string; bannedBy: string; reason: string | null }[];
  directory: Record<string, string>;
  audit: { minutesAgo: number; peer: string; session: string; event: string; detail: string }[];
  feedHealthy: boolean;
}

const PROFILES: Profile[] = [
  {
    key: 'test1',
    label: '빈칸 로그인',
    config: SERVER_SETTINGS_INI,
    scoreRates: [0.55, 0.42, 0.48],
    initialScores: [34, 27, 30],
    players: [
      { name: '레드', steamId: '76561198100000101', faction: 'RED', kills: 14, deaths: 6, cash: 5200, ping: 31 },
      { name: '채미안', steamId: '76561198100000102', faction: 'RED', kills: 9, deaths: 11, cash: 3100, ping: 48 },
      { name: '윤하율몽아', steamId: '76561198100000103', faction: 'RED', kills: 6, deaths: 4, cash: 2650, ping: 22 },
      { name: '뽀뽀르이', steamId: '76561198100000104', faction: 'RED', kills: 3, deaths: 9, cash: 1400, ping: 95 },
      { name: '은은결아', steamId: '76561198100000105', faction: 'BLU', kills: 17, deaths: 8, cash: 6800, ping: 27 },
      { name: '안슬현', steamId: '76561198100000106', faction: 'BLU', kills: 11, deaths: 10, cash: 4100, ping: 64 },
      { name: '테테', steamId: null, faction: 'BLU', kills: 2, deaths: 5, cash: 900, ping: 58 },
      { name: '이이별뽀이', steamId: '76561198100000107', faction: 'BLU', kills: 8, deaths: 5, cash: 3300, ping: 41 },
      { name: '푸르로서', steamId: '76561198100000108', faction: 'BLU', kills: 2, deaths: 12, cash: 900, ping: 138 },
      { name: '솔솔', steamId: '76561198100000109', faction: 'GRN', kills: 13, deaths: 7, cash: 5000, ping: 33 },
      { name: '몽셀제', steamId: '76561198100000110', faction: 'GRN', kills: 10, deaths: 10, cash: 3800, ping: 55 },
      { name: '슈가세이', steamId: '76561198100000111', faction: 'GRN', kills: 7, deaths: 3, cash: 2900, ping: 73 },
      { name: '셀셀뽀밀크', steamId: '76561198100000112', faction: 'GRN', kills: 5, deaths: 14, cash: 1750, ping: 19 },
    ],
    joiners: ['루이니런', '체리여루', '제아밀이', '예혁채이', '세라노이', '담혁혁이', '허니이', '르모모', '와드', '꿀벌', '냉동인간', '주차금지', '외국인', '칠각형', '오빠', '한강', '파닥', '구구콘', '양국', '버블', '체리', '마이너스', '히딩크', '다운로드'],
    joinerIdBase: 76561198100000401n,
    bans: [
      { steamId: '76561198000000003', bannedAtUtc: '-', bannedBy: 'config', reason: '(ServerSettings.ini에서 설정)' },
      { steamId: '76561198100000301', bannedAtUtc: '2026-08-09 21:14:02Z', bannedBy: '딩동', reason: '핵 사용 - 에임봇' },
      { steamId: '76561198100000302', bannedAtUtc: '2026-08-10 09:41:55Z', bannedBy: 'console', reason: '아군 방해' },
      { steamId: '76561198100000303', bannedAtUtc: '2026-08-11 16:03:10Z', bannedBy: '딩동', reason: '음성 채팅 욕설' },
      { steamId: '76561198100000304', bannedAtUtc: '2026-08-12 10:22:47Z', bannedBy: '햄버거', reason: '맵 버그 악용' },
    ],
    directory: {
      '76561198100000201': '런셀레우', '76561198100000202': '제젤리온', '76561198100000203': '무푸르베리',
      '76561198100000301': '서온루레몽', '76561198100000302': '우엘', '76561198100000303': '모모', '76561198100000304': '여셀베리이',
      '76561198000000001': '유러비담', '76561198000000003': '밀준바모카',
    },
    audit: [
      { minutesAgo: 45, peer: '127.0.0.1:51022', session: '9f3ab1c2', event: 'ACCEPT', detail: '-' },
      { minutesAgo: 44.8, peer: '127.0.0.1:51022', session: '9f3ab1c2', event: 'AUTH_FAIL', detail: 'bad password' },
      { minutesAgo: 44.5, peer: '127.0.0.1:51022', session: '9f3ab1c2', event: 'AUTH_OK', detail: '-' },
      { minutesAgo: 44.4, peer: '127.0.0.1:51022', session: '9f3ab1c2', event: 'COMMAND', detail: 'status' },
      { minutesAgo: 44.3, peer: '127.0.0.1:51022', session: '9f3ab1c2', event: 'COMMAND', detail: 'players' },
      { minutesAgo: 38, peer: '127.0.0.1:51022', session: '9f3ab1c2', event: 'COMMAND', detail: 'broadcast 10분 뒤 서버를 재시작합니다' },
      { minutesAgo: 34, peer: '127.0.0.1:51022', session: '9f3ab1c2', event: 'COMMAND', detail: 'kick 76561198100000399 팀킬' },
      { minutesAgo: 25, peer: '127.0.0.1:51022', session: '9f3ab1c2', event: 'COMMAND', detail: 'changemap Kavkazi Bakurani_KOTH_01 DayLateClear' },
      { minutesAgo: 23, peer: '127.0.0.1:51022', session: '9f3ab1c2', event: 'CLOSE', detail: '-' },
      { minutesAgo: 12, peer: '127.0.0.1:51139', session: 'c41d09aa', event: 'ACCEPT', detail: '-' },
      { minutesAgo: 11.9, peer: '127.0.0.1:51139', session: 'c41d09aa', event: 'REJECT', detail: 'rate limited' },
    ],
    feedHealthy: false,
  },
];

const WEAPONS: { cause: string; min: number; max: number; weight: number; tags?: string[] }[] = [
  { cause: 'Id.Item.AK74', min: 5, max: 220, weight: 14 },
  { cause: 'Id.Item.M4A1_Block2', min: 5, max: 240, weight: 14 },
  { cause: 'Id.Item.AKM', min: 5, max: 180, weight: 8 },
  { cause: 'Id.Item.G36C', min: 5, max: 200, weight: 6 },
  { cause: 'Id.Item.M249', min: 10, max: 300, weight: 5 },
  { cause: 'Id.Item.PKM', min: 10, max: 320, weight: 5 },
  { cause: 'Id.Item.SVD', min: 60, max: 600, weight: 4 },
  { cause: 'Id.Item.M24', min: 80, max: 750, weight: 3 },
  { cause: 'Id.Item.Glock17', min: 2, max: 40, weight: 3 },
  { cause: 'Id.Item.RPG7', min: 15, max: 250, weight: 2, tags: ['Tag.VehicleExplosion'] },
  { cause: 'Id.Item.Knife', min: 1, max: 2, weight: 1, tags: ['Tag.WeaponMelee'] },
];
const WEAPON_TOTAL = WEAPONS.reduce((n, w) => n + w.weight, 0);

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
const between = (rng: Rng, min: number, max: number) => min + rng() * (max - min);
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const revisionOf = (text: string) => `demo${createHash('sha1').update(text).digest('hex').slice(0, 8)}`;
const utcStamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + 'Z';

const directory = new Map<string, string>();

export function demoProfiles(ids: string[]): Record<string, { name: string; avatar: string }> {
  const out: Record<string, { name: string; avatar: string }> = {};
  for (const id of ids) {
    if (!isDemoSteamId(id)) continue;
    let name = directory.get(id);
    if (!name) {
      let hash = 0;
      for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      name = `${UNKNOWN_NAMES[hash % UNKNOWN_NAMES.length]}_${id.slice(-3)}`;
    }
    out[id] = { name, avatar: '' };
  }
  return out;
}

interface Person {
  steamId: string | null;
  name: string;
  skill: number;
}

interface Sim {
  person: Person;
  faction: string | null;
  kills: number;
  deaths: number;
  cash: number;
  cashPeak: number;
  earned: number;
  pingMs: number;
}

type Selection = RotationEntry;

interface Ban {
  steamId: string;
  bannedAtUtc: string;
  bannedBy: string;
  reason: string | null;
}

type GameEvent = Record<string, unknown> & { eventId: string; type: string };
type Json = Record<string, any>;

const isDenied = (s: Selection) => !s.experiences.length || s.experiences.some((id) => !EXPERIENCES.some((e) => e.id === id));

class DemoGame {
  profile: Profile;
  rng: Rng;
  roster: Person[];
  config: string;
  bans: Ban[];
  online: Sim[] = [];
  current: Selection;
  scores: number[] = FACTIONS.map(() => 0);
  scoreTick: number;
  matchSeconds = 0;
  postLeft: number | null = null;
  burst = 0;
  bootedAt: number;
  seq = 0;
  sent = 0;
  pending: GameEvent[] = [];
  kickedUntil = new Map<string, number>();
  audit: Json[] = [];
  session = createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 8);

  constructor(profile: Profile, rng: Rng, now: number) {
    this.profile = profile;
    this.rng = rng;
    this.config = remapIds(profile.config);
    this.bans = profile.bans.map((b) => ({ ...b, steamId: demoId(b.steamId) }));
    const joiners = profile.joiners.map((name, i) => ({ name, steamId: demoId(String(profile.joinerIdBase + BigInt(i))), skill: between(rng, 0.6, 1.4) }));
    this.roster = [...profile.players.map((p) => ({ name: p.name, steamId: p.steamId && demoId(p.steamId), skill: 0.6 + p.kills / 20 })), ...joiners];
    this.scoreTick = this.configTick();
    this.bootedAt = now - between(rng, 2, 9) * 3600_000;
    this.current = this.rotation()[0] ?? { map: 'Kavkazi', experiences: ['Bakurani_KOTH_01'], lighting: 'DayClear', alternator: 'None' };
    while (this.online.length < this.target) this.join(now);
  }

  get target() {
    return Math.min(ONLINE_TARGET, this.maxPlayers);
  }

  get serverName() {
    return getValue(this.config, S_SESSION, 'ServerName') || '데모 서버';
  }

  get maxPlayers() {
    return Math.min(100, Number(getValue(this.config, S_ENGINE, 'MaxPlayers')) || 64);
  }

  get reserved() {
    return reservedIdsInDoc(this.config);
  }

  configTick() {
    const n = Number(getValue(this.config, S_KOTH, 'ScorePeriod'));
    return Number.isFinite(n) && n > 0 ? Math.min(30, Math.max(18, n)) : 24;
  }

  rotation(): Selection[] {
    return rotationEntriesInDoc(this.config).map(parseRotationEntry).filter((e) => e.map)
      .map((e) => ({ map: e.map, experiences: e.experiences, lighting: e.lighting || 'DayClear', alternator: e.alternator || 'None' }));
  }

  rotationOn() {
    return /^true$/i.test(getValue(this.config, S_ROTATION, 'bEnabled') ?? 'True');
  }

  rotationRandom() {
    return /^random$/i.test(getValue(this.config, S_ROTATION, 'RotationMode') ?? '');
  }

  nowIndex(list = this.rotation()) {
    return list.findIndex((r) => sameSelection(r, this.current));
  }

  nextIndex(list = this.rotation()): number {
    if (!this.rotationOn() || list.length < 2 || this.rotationRandom()) return -1;
    const from = this.nowIndex(list);
    for (let step = 1; step <= list.length; step++) {
      const i = (from + step) % list.length;
      if (!isDenied(list[i]!)) return i;
    }
    return -1;
  }

  nextPick(): Selection {
    const list = this.rotation();
    if (!this.rotationOn() || !list.length) return this.current;
    if (this.rotationRandom()) return pick(this.rng, list.filter((e) => !isDenied(e))) ?? this.current;
    return list[this.nextIndex(list)] ?? this.current;
  }

  factionOf = (id: string) => this.find(id)?.faction ?? null;

  find(id: string) {
    return this.online.find((s) => s.person.steamId === id) ?? null;
  }

  event(type: string, extra: Record<string, unknown>): GameEvent {
    return { eventId: `demo-${this.profile.key}-${(this.seq++).toString(36)}`, type, mapName: this.current.map, eventTime: this.matchSeconds, ...extra };
  }

  smallestFaction(): string {
    const count = (f: string) => this.online.filter((s) => s.faction === f).length;
    return FACTIONS.map((f) => f.name).sort((a, b) => count(a) - count(b))[0]!;
  }

  join(now: number): Sim | null {
    const blocked = new Set([...this.online.map((s) => s.person.name), ...this.bans.map((b) => b.steamId)]);
    for (const [id, until] of this.kickedUntil) if (until > now) blocked.add(id); else this.kickedUntil.delete(id);
    const free = this.roster.filter((p) => !blocked.has(p.name) && !(p.steamId && blocked.has(p.steamId)));
    if (!free.length || this.online.length >= this.maxPlayers) return null;
    const person = pick(this.rng, free);
    const sim: Sim = { person, faction: this.smallestFaction(), kills: 0, deaths: 0, cash: 0, cashPeak: 0, earned: 0, pingMs: Math.round(between(this.rng, 15, 120)) };
    this.online.push(sim);
    return sim;
  }

  leave(sim: Sim) {
    this.online.splice(this.online.indexOf(sim), 1);
    return this.event('player_left', { steamId: sim.person.steamId, playerName: sim.person.name, players: this.online.length });
  }

  weighted(list: Sim[], weight: (s: Sim) => number): Sim {
    const total = list.reduce((n, s) => n + weight(s), 0);
    let r = this.rng() * total;
    for (const s of list) if ((r -= weight(s)) <= 0) return s;
    return list[list.length - 1]!;
  }

  addCash(s: Sim, amount: number) {
    s.cash = Math.max(0, s.cash + amount);
    if (amount > 0) s.earned += amount;
    s.cashPeak = Math.max(s.cashPeak, s.cash);
  }

  death(victim: Sim, tags: string[]): GameEvent {
    victim.deaths++;
    return this.event('killed', { victimSteamId: victim.person.steamId, victimName: victim.person.name, contextTags: tags });
  }

  kill(): GameEvent | null {
    if (this.online.length < 2) return null;
    const rng = this.rng;
    const victim = this.weighted(this.online, (s) => 1 / s.person.skill);
    if (victim.cash >= 200 && rng() < 0.3) this.addCash(victim, -Math.min(victim.cash, 150 + Math.floor(rng() * 300)));
    if (rng() < 0.02) return this.death(victim, ['Tag.Death', 'Tag.Falling']);
    const teamkill = !!victim.faction && rng() < 0.04;
    const pool = this.online.filter((s) => s !== victim && (teamkill ? s.faction === victim.faction : s.faction !== victim.faction || !s.faction));
    if (!pool.length) return null;
    victim.deaths++;
    const killer = this.weighted(pool, (s) => s.person.skill);
    let r = rng() * WEAPON_TOTAL;
    const weapon = WEAPONS.find((w) => (r -= w.weight) <= 0) ?? WEAPONS[0]!;
    const tags = ['Tag.Kill', ...(weapon.tags ?? [])];
    if (!weapon.tags && rng() < 0.2 * killer.person.skill) tags.push('Tag.Headshot');
    if (!weapon.tags && rng() < 0.05) tags.push('Tag.Penetration');
    killer.kills++;
    this.addCash(killer, teamkill ? -500 : 150);
    return this.event('killed', {
      killerSteamId: killer.person.steamId, killerName: killer.person.name,
      victimSteamId: victim.person.steamId, victimName: victim.person.name,
      cause: weapon.cause, distance: Math.round(between(rng, weapon.min, weapon.max) * 100), contextTags: tags,
    });
  }

  loadMap(next: Selection): GameEvent[] {
    this.current = next;
    this.postLeft = null;
    this.matchSeconds = 0;
    this.scores = FACTIONS.map(() => 0);
    this.scoreTick = this.configTick();
    for (const s of this.online) Object.assign(s, { kills: 0, deaths: 0, cash: 0, cashPeak: 0, earned: 0 });
    return [
      this.event('match_state', { state: 'MatchState.PreMatch.WaitingForWorldLoad' }),
      this.event('match_state', { state: S_KOTH }),
    ];
  }

  endMatch(): GameEvent[] {
    if (this.postLeft != null) return [];
    const best = Math.max(...this.scores.map(Math.floor));
    const leaders = FACTIONS.filter((_, i) => Math.floor(this.scores[i]!) === best);
    this.postLeft = POST_MATCH_SEC;
    return [
      this.event('match_state', { state: 'MatchState.PostMatch' }),
      this.event('match_ended', {
        winningFaction: leaders.length === 1 ? leaders[0]!.name : null,
        factionScores: FACTIONS.map((f, i) => ({ faction: f.name, score: Math.min(100, Math.floor(this.scores[i]!)) })),
      }),
    ];
  }

  official(now: number): GameEvent[] {
    this.audit = this.profile.audit.map((e) => ({
      timestampUtc: utcStamp(now - e.minutesAgo * 60_000), peer: e.peer, sessionId: e.session, event: e.event, detail: remapIds(e.detail),
    }));
    const out = this.loadMap(this.current);
    this.scores = [...this.profile.initialScores];
    this.matchSeconds = OFFICIAL_MATCH_SECONDS;
    const keep = this.profile.players;
    while (this.online.length) out.push(this.leave(this.online[0]!));
    for (const p of keep) {
      const person = this.roster.find((r) => r.name === p.name)!;
      this.online.push({ person, faction: factionName(p.faction), kills: p.kills, deaths: p.deaths, cash: p.cash, cashPeak: p.cash, earned: p.cash, pingMs: p.ping });
      out.push(this.event('player_joined', { steamId: person.steamId, playerName: person.name, players: this.online.length }));
    }
    this.kickedUntil.clear();
    return out;
  }

  second(now: number): GameEvent[] {
    const rng = this.rng;
    const out: GameEvent[] = [];
    if (this.postLeft != null) {
      if (--this.postLeft <= 0) out.push(...this.loadMap(this.nextPick()));
      return out;
    }

    this.matchSeconds++;
    FACTIONS.forEach((_, i) => { this.scores[i]! += this.profile.scoreRates[i]! * SCORE_SPEED * (0.8 + rng() * 0.4); });

    const kills: (GameEvent | null)[] = [];
    if (this.burst > 0) {
      this.burst--;
      if (rng() < 0.35) kills.push(this.kill());
    } else if (rng() < 0.012) {
      this.burst = Math.round(between(rng, 8, 25));
    }
    if (rng() < 0.03 * (this.online.length / ONLINE_TARGET)) kills.push(this.kill());
    out.push(...kills.filter((e): e is GameEvent => !!e));

    const drift = this.target - this.online.length;
    if (rng() < 0.006 + Math.max(0, -drift) * 0.004 && this.online.length > 2) out.push(this.leave(this.online[Math.floor(rng() * this.online.length)]!));
    if (rng() < 0.006 + Math.max(0, drift) * 0.01) {
      const s = this.join(now);
      if (s) out.push(this.event('player_joined', { steamId: s.person.steamId, playerName: s.person.name, players: this.online.length }));
    }

    if (this.scores.some((s) => s >= 100)) out.push(...this.endMatch());
    return out;
  }

  advance(seconds: number, now: number): GameEvent[] {
    const out = this.pending.splice(0);
    for (let i = 0; i < seconds; i++) out.push(...this.second(now));
    this.sent += out.length;
    return out;
  }

  status() {
    return {
      serverName: this.serverName,
      map: this.current.map,
      experiences: [...this.current.experiences],
      lighting: this.current.lighting,
      alternator: this.current.alternator === 'None' ? '' : this.current.alternator,
      players: { current: this.online.length, max: this.maxPlayers },
      factionScores: FACTIONS.map((f, i) => ({ name: f.name, colorHex: f.colorHex, score: Math.min(100, Math.floor(this.scores[i]!)) })),
      scoreTick: { current: this.scoreTick, min: 18, max: 30 },
      scoreCap: 100,
      matchSeconds: this.matchSeconds,
    };
  }

  players() {
    return this.online.map((s) => ({
      steamId: s.person.steamId ?? undefined, name: s.person.name, faction: s.faction ?? undefined,
      kills: s.kills, deaths: s.deaths, cash: s.cash, pingMs: Math.max(5, s.pingMs + Math.floor(this.rng() * 17) - 8),
    }));
  }

  scoreRows(matchKey: string, at: number): MatchPlayerDelta[] {
    return this.online.filter((s) => s.person.steamId).map((s) => ({
      matchKey, steamId: s.person.steamId!, map: this.current.map, faction: s.faction,
      kills: s.kills, deaths: s.deaths, cashPeak: s.cashPeak, earned: s.earned, at,
    }));
  }

  cashPoint(t: number) {
    const point = { t, total: 0, factions: {} as Record<string, number> };
    for (const s of this.online) {
      point.total += s.cash;
      if (s.faction) point.factions[s.faction] = (point.factions[s.faction] ?? 0) + s.cash;
    }
    return point;
  }

  rotationView() {
    const list = this.rotation();
    const now = this.nowIndex(list);
    const next = this.nextIndex(list);
    return {
      enabled: this.rotationOn(),
      mode: this.rotationRandom() ? 'Random' : 'Ordered',
      nowIndex: now,
      nextIndex: next,
      entries: list.map((r, index) => ({
        index, map: r.map, experiences: r.experiences, lighting: r.lighting, alternator: r.alternator, denied: isDenied(r),
        status: index === now ? 'now' : index === next ? 'next' : undefined,
      })),
    };
  }

  log(detail: string) {
    this.audit.push({ timestampUtc: utcStamp(Date.now()), peer: 'dashboard', sessionId: this.session, event: 'COMMAND', detail });
    if (this.audit.length > 500) this.audit.splice(0, this.audit.length - 500);
  }
}

const ROUTES = [
  'GET /v1/capabilities', 'GET /v1/status', 'GET /v1/players', 'GET /v1/health', 'GET /v1/version',
  'GET /v1/feed', 'GET /v1/audit', 'GET /v1/bans', 'POST /v1/bans', 'DELETE /v1/bans/{steamId}',
  'POST /v1/players/{steamId}/message', 'POST /v1/players/{steamId}/kick', 'POST /v1/players/{steamId}/kill', 'PATCH /v1/players/{steamId}',
  'POST /v1/broadcast', 'GET /v1/reserved-slots', 'POST /v1/reserved-slots', 'DELETE /v1/reserved-slots/{steamId}',
  'GET /v1/rotation', 'GET /v1/catalog/maps', 'GET /v1/catalog/lightings', 'GET /v1/catalog/experiences',
  'GET /v1/catalog/maps/{id}/experiences', 'GET /v1/catalog/maps/{id}/alternators', 'POST /v1/match/map', 'POST /v1/match/end',
  'POST /v1/match/restart', 'PUT /v1/world/lighting', 'GET /v1/config', 'PUT /v1/config', 'POST /v1/config/validate', 'GET /v1/sponsor',
];

class DemoRcon extends RconClient {
  game: DemoGame;

  constructor(row: ServerRow, game: DemoGame) {
    super({ baseUrl: row.rconUrl, password: row.rconPassword });
    this.game = game;
  }

  override async request(method: string, path: string, opts: { json?: unknown; text?: string; headers?: Record<string, string>; query?: Record<string, unknown> } = {}) {
    const route = path.split('?')[0]!;
    const body = method === 'GET' ? this.read(route) : this.write(method, route, (opts.json ?? {}) as Json, opts);
    if (!body) throw new RconError(404, 'no_route', '데모 서버에 없는 요청입니다');
    return { status: 200, body, etag: null };
  }

  read(path: string): Json | null {
    const g = this.game;
    const now = Date.now();
    const map = /^\/v1\/catalog\/maps\/([^/]+)\/(experiences|alternators)$/.exec(path);
    if (map) {
      const id = decodeURIComponent(map[1]!);
      return map[2] === 'experiences'
        ? { experiences: EXPERIENCES_BY_MAP[id] ?? EXPERIENCES.map((e) => e.id) }
        : { alternators: ALTERNATORS_BY_MAP[id] ?? [] };
    }
    switch (path) {
      case '/v1/capabilities':
        return { apiVersion: '1', build: 'Wardogs-0.2.0-demo+sandbox', limits: { maxRequestsPerMinutePerIp: 600 }, config: { writable: true }, routes: ROUTES };
      case '/v1/status': return g.status();
      case '/v1/players': return { players: g.players() };
      case '/v1/health': return { uptimeSeconds: Math.floor((now - g.bootedAt) / 1000), gameThreadQueue: { depth: 0, rejectedTotal: 0 } };
      case '/v1/version':
        return { build: 'Wardogs-0.2.0-demo+sandbox', project: { name: 'Wardogs', version: '0.2.0-demo' } };
      case '/v1/feed': {
        const sec = Math.floor(now / 1000);
        const endpoints = [{ index: 0, scheme: 'https', host: 'example.com', healthy: true, queued: 0, inFlight: 1, consecutiveFailures: 0, sentTotal: 4812 + g.sent, droppedTotal: 0, lastHttpStatus: 204, lastSuccessUnixSeconds: sec - 7 }];
        if (!g.profile.feedHealthy) {
          endpoints.push({ index: 1, scheme: 'https', host: 'hooks.example.org', healthy: false, queued: 64, inFlight: 0, consecutiveFailures: 9, sentTotal: 311, droppedTotal: 22, lastHttpStatus: 502, lastSuccessUnixSeconds: sec - 1840 });
        }
        return { enabled: true, endpointCount: endpoints.length, anyUnhealthy: !g.profile.feedHealthy, endpoints };
      }
      case '/v1/audit': return { entries: g.audit.slice(-200).reverse() };
      case '/v1/bans': return { bans: g.bans };
      case '/v1/reserved-slots': return { reservedSlots: g.reserved };
      case '/v1/rotation': return g.rotationView();
      case '/v1/catalog/maps': return { maps: MAPS };
      case '/v1/catalog/lightings': return { lightings: LIGHTINGS };
      case '/v1/catalog/experiences': return { experiences: EXPERIENCES };
      case '/v1/sponsor': return { imageUrl: getValue(g.config, S_SESSION, 'ServerImageURL') ?? '' };
      case '/v1/config':
        return { revision: revisionOf(g.config), writable: true, text: g.config, sections: CONFIG_SECTIONS, warnings: [] };
      default: return null;
    }
  }

  write(method: string, path: string, json: Json, opts: { text?: string; headers?: Record<string, string>; query?: Record<string, unknown> }): Json | null {
    const g = this.game;
    const player = /^\/v1\/players\/([^/]+)(?:\/(message|kick|kill))?$/.exec(path);
    if (player) {
      const id = decodeURIComponent(player[1]!);
      const sim = g.find(id);
      if (!sim) throw new RconError(404, 'player_not_found', `플레이어를 찾을 수 없습니다: ${id}`);
      const name = sim.person.name;
      switch (player[2]) {
        case 'message':
          g.log(`msg ${id} ${json.message}`);
          return { ok: true, message: `${name}에게 귓속말을 보냈습니다.` };
        case 'kick':
          g.kickedUntil.set(id, Date.now() + KICK_REJOIN_MS);
          g.pending.push(g.leave(sim));
          g.log(`kick ${id} ${json.reason ?? ''}`.trim());
          return { ok: true, message: `${name}을(를) 킥했습니다.` };
        case 'kill':
          g.pending.push(g.death(sim, ['Tag.Death', 'Tag.Suicide']));
          g.log(`kill ${id}`);
          return { ok: true, message: `${name}을(를) 처치했습니다.` };
      }
      const faction = FACTIONS.find((f) => f.name === json.faction);
      if (method !== 'PATCH' || !faction) throw new RconError(400, 'bad_faction', `Unknown faction '${json.faction}'.`);
      sim.faction = faction.name;
      g.log(`changeteam ${id} ${faction.name}`);
      return { ok: true, message: `${name}을(를) ${faction.name}(으)로 옮겼습니다.` };
    }
    const ban = /^\/v1\/bans\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && ban) {
      const id = decodeURIComponent(ban[1]!);
      if (!g.bans.some((b) => b.steamId === id)) throw new RconError(404, 'not_banned', `${id} is not banned.`);
      g.bans = g.bans.filter((b) => b.steamId !== id);
      g.log(`unban ${id}`);
      return { ok: true };
    }
    const slot = /^\/v1\/reserved-slots\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && slot) return this.reserve(decodeURIComponent(slot[1]!), false);

    switch (`${method} ${path}`) {
      case 'POST /v1/broadcast':
        g.log(`broadcast ${json.message}`);
        return { ok: true, message: `${g.online.length}명에게 공지를 보냈습니다.` };
      case 'POST /v1/bans': {
        const id = String(json.steamId);
        const sim = g.find(id);
        if (sim) g.pending.push(g.leave(sim));
        g.bans = [...g.bans.filter((b) => b.steamId !== id), { steamId: id, bannedAtUtc: utcStamp(Date.now()), bannedBy: 'web', reason: json.reason || '-' }];
        g.log(`ban ${id} ${json.reason ?? ''}`.trim());
        return { ok: true };
      }
      case 'POST /v1/reserved-slots': return this.reserve(String(json.steamId), true);
      case 'POST /v1/match/map': {
        if (!MAPS.some((m) => m.id === json.map)) throw new RconError(400, 'bad_map', `Unknown map '${json.map}'.`);
        const experiences: string[] = json.experiences?.length ? json.experiences : g.current.experiences;
        g.pending.push(...g.loadMap({ map: json.map, experiences, lighting: json.lighting || g.current.lighting, alternator: json.zoneAlternator || 'None' }));
        g.log(`changemap ${json.map} ${experiences.join('+')} ${json.lighting ?? ''}`.trim());
        return { ok: true, message: `${json.map}(으)로 맵을 바꾸는 중입니다.` };
      }
      case 'POST /v1/match/end':
        g.pending.push(...g.endMatch());
        g.log('endmatch');
        return { ok: true };
      case 'POST /v1/match/restart':
        g.pending.push(...g.loadMap(g.current));
        g.log('restartmatch');
        return { ok: true };
      case 'PUT /v1/world/lighting':
        if (!LIGHTINGS.some((l) => l.id === json.lighting)) throw new RconError(400, 'bad_lighting', `Unknown lighting '${json.lighting}'.`);
        g.current = { ...g.current, lighting: json.lighting };
        g.log(`weather ${json.lighting}`);
        return { ok: true };
      case 'POST /v1/config/validate': return { ok: true, revision: revisionOf(g.config), outcomes: this.outcomes(opts.text ?? '') };
      case 'PUT /v1/config': {
        const wanted = opts.headers?.['If-Match']?.replace(/"/g, '');
        const revision = revisionOf(g.config);
        if (wanted && wanted !== revision && !opts.query?.force) {
          throw new RconError(412, 'revision_mismatch', `리비전 ${wanted} 이후 설정이 바뀌었습니다 (현재 ${revision}).`,
            { ok: false, conflict: true, revision, errors: [], error: { message: `리비전 ${wanted} 이후 설정이 바뀌었습니다 (현재 ${revision}).` } });
        }
        g.config = opts.text ?? g.config;
        g.log(`config -> ${revisionOf(g.config)}`);
        return { ok: true, revision: revisionOf(g.config), outcomes: this.outcomes(g.config) };
      }
      default: return null;
    }
  }

  outcomes(text: string) {
    return [...text.matchAll(/^\s*\[(.+)\]\s*$/gm)].map((m) => ({
      section: m[1], detail: '',
      state: /KOTH|PreMatch|GameStateSession/.test(m[1]!) ? 'next-match' : /Engine\.GameSession/.test(m[1]!) ? 'next-restart' : 'applied',
    }));
  }

  reserve(steamId: string, present: boolean): Json {
    const g = this.game;
    const max = Number(getValue(g.config, S_SESSION, 'MaxReservedSlots') ?? Infinity);
    if (present && !g.reserved.includes(steamId) && g.reserved.length >= max) {
      throw new RconError(409, 'reserved_full', `예약 슬롯이 가득 찼습니다 (${g.reserved.length}/${max}). ServerSettings.ini에서 MaxReservedSlots를 늘리세요.`);
    }
    g.config = setReservedInDoc(g.config, steamId, present);
    g.log(`reserved ${present ? 'add' : 'remove'} ${steamId}`);
    return { ok: true };
  }
}

interface Seeded {
  row: ServerRow;
  game: DemoGame;
  cash: { matchKey: string | null; points: ReturnType<DemoGame['cashPoint']>[] };
}

const STAFF = [
  { steamId: '76561197000009001', name: '딩동' },
  { steamId: '76561197000009002', name: '햄버거' },
];

function seedServer(store: Store, weapons: WeaponLookup, profile: Profile, index: number, now: number): Seeded {
  const rng = mulberry32(20261027 + index);
  const start = now - HISTORY_MS;
  const game = new DemoGame(profile, mulberry32(7 + index), start);
  for (const [id, name] of Object.entries(profile.directory)) directory.set(demoId(id), name);
  for (const p of game.roster) if (p.steamId) directory.set(p.steamId, p.name);

  let row = store.createServer(game.serverName, `${DEMO_PREFIX}${profile.key}`, 'demo', STAFF[0]!.steamId);
  const joinCode = index ? `demo-${profile.key}` : 'demo';
  if (!store.servers().some((s) => s.joinCode === joinCode)) row = store.updateServer(row.id, { joinCode }) ?? row;
  const s = store.forServer(row.id);
  const scoreRows: MatchPlayerDelta[] = [];
  let points: Seeded['cash']['points'] = [];
  let pointsKey: string | null = null;

  store.tx(() => {
    store.setMember(row.id, STAFF[1]!.steamId, 'admin', STAFF[0]!.steamId);
    for (const p of game.roster) {
      if (!p.steamId) continue;
      const first = start - between(rng, 0, 20) * 86400_000;
      s.seePlayer(p.steamId, p.name, first, true, true);
      for (let i = Math.floor(between(rng, 1, 10)); i > 0; i--) s.seePlayer(p.steamId, p.name, first + (start - first) * rng(), true, true);
    }

    const feed = new FeedProcessor({ store: s, weapons, gapSec: 15, minKills: 3, factionOf: game.factionOf, emit: () => {} });
    let lastPoint = 0;
    const ingest = (events: GameEvent[], t: number) => {
      feed.ingest({ serverName: game.serverName, events }, t);
      if (now - t < 30 * 60_000) s.logFeedRequest({ at: t, peer: '127.0.0.1', status: 200, events: events.length, accepted: events.length, duplicates: 0 });
      if (feed.matchKey !== pointsKey) {
        pointsKey = feed.matchKey;
        points = [];
      }
      if (game.postLeft == null && t - lastPoint >= CASH_SAMPLE_MS) {
        points.push(game.cashPoint(t));
        lastPoint = t;
      }
      if (events.some((e) => e.type === 'match_ended') && feed.matchKey) scoreRows.push(...game.scoreRows(feed.matchKey, t));
    };
    const officialAt = now - OFFICIAL_MATCH_SECONDS * 1000;
    for (let t = start; t < officialAt; t += HISTORY_STEP_SEC * 1000) {
      const events = game.advance(HISTORY_STEP_SEC, t);
      if (events.length) ingest(events, t);
    }
    if (feed.matchKey) scoreRows.push(...game.scoreRows(feed.matchKey, officialAt));
    game.current = game.rotation()[0] ?? game.current;
    ingest(game.official(now), now);
    points = [game.cashPoint(now)];
    for (const sim of game.online) if (sim.person.steamId) s.seePlayer(sim.person.steamId, sim.person.name, now, true, true);

    if (index === 0) seedPanelExtras(s, game, rng, now);
    seedActions(store, row.id, profile, now);
  });
  s.addMatchPlayers(scoreRows);
  if (index === 0) {
    game.roster.filter((p) => p.steamId).slice(0, 8).forEach((p, i) =>
      store.saveLink(p.steamId!, p.name, `demo-chzzk-${i}`, `${p.name}`, sqlTime(now - between(rng, 1, 400) * 3600_000)));
  }
  return { row, game, cash: { matchKey: pointsKey, points } };
}

function seedPanelExtras(s: ReturnType<Store['forServer']>, game: DemoGame, rng: Rng, now: number) {
  const byName = (name: string) => game.roster.find((p) => p.name === name)!;
  const streamers = [byName('레드'), byName('은은결아'), byName('솔솔')];
  streamers.forEach((p, i) => {
    s.saveDiscordLink(`10${String(4_000_000_000_000_000 + i * 9_731)}`, `${p.name.toLowerCase()}#${1000 + i}`,
      { steamId: p.steamId!, steamName: p.name, chzzkChannelId: `demo-chzzk-${i}`, chzzkName: `${p.name}` }, now - (i + 1) * 30 * 3600_000);
    s.markDiscordReserved(p.steamId!, null);
  });
  s.setConfigPresets([
    { name: '스크림', values: { minRequiredPlayers: 20, scorePeriod: 20 }, savedAt: now - 3 * 86400_000, savedBy: '딩동' },
    { name: '일반', values: { minRequiredPlayers: 60, scorePeriod: 24 }, savedAt: now - 9 * 86400_000, savedBy: '햄버거' },
  ]);
  s.addPendingBan(demoId('76561198100000399'), '팀킬 (반복)', '딩동');

  const reports = [
    { target: byName('이이별뽀이'), category: 'cheat', text: '우랄이 날라다닙니다. 영상 첨부합니다.', status: 'open' },
    { target: byName('윤하율몽아'), category: 'teamkill', text: '아군 FOB를 고의로 터트렸습니다.', status: 'open' },
    { target: byName('푸르로서'), category: 'abuse', text: '전체 채팅에서 욕설을 난사합니다.', status: 'resolved', note: '경고 후 킥' },
    { target: byName('뽀뽀르이'), category: 'grief', text: '계속 의도적으로 팀킬을 합니다.', status: 'rejected', note: '경고' },
  ];
  reports.forEach((r, i) => {
    const reporter = game.roster[(i + 4) % 13]!;
    const created = now - (i * 4 + 1) * 3600_000;
    const rep = s.addReport({
      createdAt: created, reporterChzzkId: `demo-chzzk-r${i}`, reporterChzzkName: `${reporter.name}`,
      reporterSteamId: reporter.steamId, reporterSteamName: reporter.name,
      reporterDiscordId: null, reporterDiscordName: null, targetName: r.target.name, targetSteamId: r.target.steamId,
      category: r.category, description: r.text, evidenceUrl: i % 2 ? null : 'https://example.com/clip/demo', map: pick(rng, MAPS).id,
    });
    if (r.status !== 'open') s.updateReport(rep.id, r.status, r.note ?? null, '햄버거', created + 40 * 60_000);
  });
}

function seedActions(store: Store, serverId: number, profile: Profile, now: number) {
  const insert = store.prep('INSERT INTO actions (server_id, at, actor, action, target, detail, ok, error) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)');
  for (const e of profile.audit) {
    if (e.event !== 'COMMAND') continue;
    const [cmd, ...rest] = e.detail.split(' ');
    const at = now - e.minutesAgo * 60_000;
    if (cmd === 'broadcast') insert.run(serverId, at, '딩동', 'broadcast', null, JSON.stringify({ message: rest.join(' ') }));
    else if (cmd === 'kick') insert.run(serverId, at, '딩동', 'kick', demoId(rest[0]!), JSON.stringify({ reason: rest.slice(1).join(' ') }));
    else if (cmd === 'changemap') insert.run(serverId, at, '딩동', 'change_map', rest[0]!, JSON.stringify({ map: rest[0], lighting: rest[2] }));
    else if (cmd === 'restartmatch') insert.run(serverId, at, '딩동', 'restart_match', null, null);
  }
}

export function createDemo(store: Store, weapons: WeaponLookup) {
  const games = new Map<number, DemoGame>();
  let seeded: Seeded[] = [];

  const build = () => {
    for (const row of store.servers()) if (isDemoUrl(row.rconUrl)) store.deleteServer(row.id);
    store.prep("DELETE FROM account_links WHERE chzzk_channel_id LIKE 'demo-chzzk-%'").run();
    const t0 = performance.now();
    const now = Date.now();
    for (const s of STAFF) store.touchUser(s.steamId, s.name, null, true);
    store.touchUser(GUEST_STEAM_ID, GUEST_NAME, null, false);
    directory.clear();
    seeded = PROFILES.map((p, i) => seedServer(store, weapons, p, i, now));
    games.clear();
    for (const s of seeded) games.set(s.row.id, s.game);
    console.log(`[데모] 체험 서버 ${seeded.map((s) => `#${s.row.id} ${s.row.name}`).join(', ')}를 새로 만들었습니다 (${Math.round(performance.now() - t0)}ms)`);
  };

  const prime = (fleet: Fleet) => {
    for (const { row, game, cash } of seeded) {
      const rt = fleet.get(row.id);
      if (!rt) continue;
      if (cash.matchKey === rt.feed.matchKey) Object.assign(rt.poller, { cash, lastCashAt: cash.points.at(-1)?.t ?? 0 });
      rt.feed.matchState = { state: S_KOTH, at: Date.now(), eventTime: game.matchSeconds };
    }
  };

  build();

  return {
    rcon: (row: ServerRow): RconClient | null => {
      const game = games.get(row.id);
      return game ? new DemoRcon(row, game) : null;
    },
    start(fleet: Fleet) {
      prime(fleet);
      setInterval(() => {
        const at = Date.now();
        for (const [id, game] of games) {
          const rt = fleet.get(id);
          const events = game.advance(LIVE_STEP_MS / 1000, at);
          if (!rt || !events.length) continue;
          const r = rt.feed.ingest({ serverName: game.serverName, events }, at);
          rt.store.logFeedRequest({ at, peer: '127.0.0.1', status: 200, events: events.length, accepted: r.accepted, duplicates: r.duplicates });
        }
      }, LIVE_STEP_MS).unref();
      setInterval(() => {
        for (const id of games.keys()) fleet.remove(id);
        build();
        for (const s of seeded) fleet.add(s.row);
        prime(fleet);
      }, RESET_MS).unref();
    },
  };
}

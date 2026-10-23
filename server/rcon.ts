import {
  reservedIdsInDoc, setReservedInDoc, rotationEntriesInDoc, setRotationInDoc, setRotationSettingsInDoc,
  parseRotationEntry, formatRotationEntry, sameSelection, getValue, setValue,
} from './inidoc.ts';
import type { RotationSelection, RotationSettings } from './inidoc.ts';

const SCORE_SECTION = 'MatchState.Playing.KOTH';
const SESSION_SECTION = '/Script/WDGame.WDGameSession';
const SPONSOR_KEY = 'ServerImageURL';
const SCORE_KEY = 'ScorePeriod';

type Json = Record<string, any>;

export interface GameStatus extends Json {
  serverName?: string;
  map?: string;
  experiences?: string[];
  players?: { current?: number; max?: number };
  factionScores?: { name: string; score: number; colorHex?: string }[];
  scoreTick?: { current?: number; min?: number; max?: number };
  scoreCap?: number;
  matchSeconds?: number;
}

export interface GamePlayer extends Json {
  steamId?: string;
  name?: string;
  faction?: string;
  kills?: number;
  deaths?: number;
  cash?: number;
}

export interface Capabilities extends Json {
  apiVersion?: string;
  build?: string;
  limits?: { maxRequestsPerMinutePerIp?: number };
  config?: { writable?: boolean };
  routes?: string[];
}

export interface Ban extends Json {
  steamId: string;
}

export interface ConfigDoc {
  revision: string;
  writable: boolean;
  text: string;
  sections: Json[];
  warnings: Json[];
}

export interface ConfigResult extends Json {
  status: number;
  ok: boolean;
  errors?: { message?: string; key?: string; code?: string }[];
  error?: { message?: string };
  outcomes?: { detail?: string }[];
}

export interface MapSelection {
  map: string;
  experiences?: string[];
  lighting?: string;
  zoneAlternator?: string;
}

export class RconError extends Error {
  status: number;
  code: string | undefined;
  body: unknown;

  constructor(status: number, code: string | undefined, message?: string, body?: unknown) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function normalizeRoute(route: string): string {
  return String(route).trim().replace(/\{[^}]*\}|:[^/\s]+/g, '{}').replace(/\s+/g, ' ');
}

const seg = (v: string) => encodeURIComponent(v);

function mapSelection({ map, experiences, lighting, zoneAlternator }: MapSelection): MapSelection {
  const body: MapSelection = { map };
  if (experiences?.length) body.experiences = experiences;
  if (lighting) body.lighting = lighting;
  if (zoneAlternator && zoneAlternator !== 'None') body.zoneAlternator = zoneAlternator;
  return body;
}

interface RequestOptions {
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
}

export class RconClient {
  baseUrl: string;
  password: string;
  timeoutMs: number;
  holdUntil = 0;
  capabilities: Capabilities | null = null;
  routes = new Set<string>();
  features = RconClient.noFeatures();

  constructor({ baseUrl, password, timeoutMs = 8000 }: { baseUrl: string; password: string; timeoutMs?: number }) {
    this.baseUrl = baseUrl;
    this.password = password;
    this.timeoutMs = timeoutMs;
  }

  setTarget(url: string, password: string): void {
    this.baseUrl = url;
    this.password = password;
    this.holdUntil = 0;
    this.capabilities = null;
    this.routes = new Set();
    this.features = RconClient.noFeatures();
  }

  static noFeatures() {
    return {
      changeTeam: false,
      serverId: false,
      version: false,
      health: false,
      feed: false,
      reservedRoutes: false,
      configDocument: false,
      sponsor: false,
      rotation: false,
    };
  }

  async request(method: string, path: string, { json, text, headers = {}, query }: RequestOptions = {}) {
    if (!this.baseUrl || !this.password) {
      throw new RconError(0, 'not_configured', 'RCON 연결 정보가 없습니다.');
    }
    if (Date.now() < this.holdUntil) {
      throw new RconError(429, 'rate_limited', `RCON 요청 한도 초과, ${Math.ceil((this.holdUntil - Date.now()) / 1000)}초 후 재시도`);
    }
    const url = new URL(this.baseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const init: RequestInit & { headers: Record<string, string> } = {
      method,
      headers: { Authorization: `Bearer ${this.password}`, ...headers },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (text !== undefined) {
      init.headers['Content-Type'] = 'text/plain; charset=utf-8';
      init.body = text;
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const code = e.name === 'TimeoutError' ? 'timeout' : 'unreachable';
      throw new RconError(0, code, `RCON 연결 실패: ${e.cause?.code || e.message}`);
    }

    if (res.status === 429) {
      const sec = Number(res.headers.get('retry-after'));
      this.holdUntil = Date.now() + (Number.isFinite(sec) && sec > 0 ? Math.min(sec, 60) : 5) * 1000;
    }

    const raw = await res.text();
    let body: Json | null = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { message: raw };
      }
    }
    if (!res.ok) {
      const e = body?.error ?? {};
      const code = e.code === 'not_found' ? 'no_route' : e.code;
      throw new RconError(res.status, code, e.message || body?.message || `요청 실패 (${res.status})`, body);
    }
    return { status: res.status, body: body ?? {}, etag: res.headers.get('etag') };
  }

  async get(path: string, query?: RequestOptions['query']): Promise<Json> {
    return (await this.request('GET', path, { query })).body;
  }

  async send(method: string, path: string, json?: unknown): Promise<Json> {
    return (await this.request(method, path, { json })).body;
  }

  async loadCapabilities(): Promise<Capabilities> {
    const caps: Capabilities = await this.get('/v1/capabilities');
    this.capabilities = caps;
    this.routes = new Set((caps.routes || []).map(normalizeRoute));
    const has = (r: string) => this.routes.has(normalizeRoute(r));
    this.features = {
      changeTeam: has('PATCH /v1/players/{}'),
      serverId: has('GET /v1/server-id'),
      version: has('GET /v1/version'),
      health: has('GET /v1/health'),
      feed: has('GET /v1/feed'),
      reservedRoutes: has('POST /v1/reserved-slots') && has('DELETE /v1/reserved-slots/{}'),
      configDocument: has('PUT /v1/config') && caps.config?.writable !== false,
      sponsor: has('GET /v1/sponsor'),
      rotation: has('GET /v1/rotation'),
    };
    return caps;
  }

  status(): Promise<GameStatus> {
    return this.get('/v1/status');
  }

  async players(): Promise<GamePlayer[]> {
    return (await this.get('/v1/players')).players || [];
  }

  health(): Promise<Json> {
    return this.get('/v1/health');
  }

  async serverId(): Promise<string | null> {
    return String((await this.get('/v1/server-id')).serverId || '') || null;
  }

  async version() {
    const d = await this.get('/v1/version');
    return { build: d.build ?? null, project: d.project ?? {} };
  }

  async feedHealth() {
    const d = await this.get('/v1/feed');
    return {
      enabled: !!d.enabled,
      endpointCount: Number(d.endpointCount) || 0,
      anyUnhealthy: !!d.anyUnhealthy,
      endpoints: (Array.isArray(d.endpoints) ? d.endpoints : []).map((e: Json) => ({
        index: Number(e.index) || 0,
        scheme: String(e.scheme || ''),
        host: String(e.host || ''),
        healthy: !!e.healthy,
        queued: Number(e.queued) || 0,
        inFlight: Number(e.inFlight) || 0,
        consecutiveFailures: Number(e.consecutiveFailures) || 0,
        sentTotal: Number(e.sentTotal) || 0,
        droppedTotal: Number(e.droppedTotal) || 0,
        lastHttpStatus: e.lastHttpStatus == null ? null : Number(e.lastHttpStatus),
        lastSuccessAt: e.lastSuccessUnixSeconds == null ? null : Number(e.lastSuccessUnixSeconds) * 1000,
      })),
    };
  }

  async audit(limit = 50): Promise<Json[]> {
    const n = Math.min(500, Math.max(1, Number(limit) || 50));
    return (await this.get('/v1/audit', { limit: n })).entries || [];
  }

  message(steamId: string, message: string) {
    return this.send('POST', `/v1/players/${seg(steamId)}/message`, { message });
  }

  broadcast(message: string) {
    return this.send('POST', '/v1/broadcast', { message });
  }

  kick(steamId: string, reason?: string) {
    return this.send('POST', `/v1/players/${seg(steamId)}/kick`, { reason: reason || 'Kicked by admin.' });
  }

  kill(steamId: string) {
    return this.send('POST', `/v1/players/${seg(steamId)}/kill`);
  }

  async changeFaction(steamId: string, faction: string) {
    const moved = await this.send('PATCH', `/v1/players/${seg(steamId)}`, { faction });
    let respawned = true;
    try {
      await this.kill(steamId);
    } catch {
      respawned = false;
    }
    return { ...moved, respawned };
  }

  async bans(): Promise<Ban[]> {
    return (await this.get('/v1/bans')).bans || [];
  }

  ban(steamId: string, reason?: string | null) {
    return this.send('POST', '/v1/bans', { steamId, reason: reason || undefined });
  }

  unban(steamId: string) {
    return this.send('DELETE', `/v1/bans/${seg(steamId)}`);
  }

  async reservedSlots(): Promise<Json[]> {
    return (await this.get('/v1/reserved-slots')).reservedSlots || [];
  }

  async reservedInDoc(): Promise<string[]> {
    return reservedIdsInDoc((await this.config()).text);
  }

  async setReserved(steamId: string, present: boolean) {
    if (this.features.reservedRoutes) {
      const r = present
        ? await this.send('POST', '/v1/reserved-slots', { steamId })
        : await this.send('DELETE', `/v1/reserved-slots/${seg(steamId)}`);
      return { ...r, via: 'route' };
    }
    const r = await this.editConfig((text) => ({ text: setReservedInDoc(text, steamId, present) }));
    return { ...r, via: 'config', pendingRestart: !r.unchanged };
  }

  changeMap(selection: MapSelection) {
    return this.send('POST', '/v1/match/map', mapSelection(selection));
  }

  setLighting(lighting: string) {
    return this.send('PUT', '/v1/world/lighting', { lighting });
  }

  endMatch() {
    return this.send('POST', '/v1/match/end');
  }

  restartMatch() {
    return this.send('POST', '/v1/match/restart');
  }

  async catalog() {
    const [maps, lightings, experiences] = await Promise.all([
      this.get('/v1/catalog/maps'), this.get('/v1/catalog/lightings'), this.get('/v1/catalog/experiences'),
    ]);
    return { maps: maps.maps || [], lightings: lightings.lightings || [], experiences: experiences.experiences || [] };
  }

  async mapOptions(mapId: string) {
    const id = seg(mapId);
    const [exp, alt] = await Promise.all([
      this.get(`/v1/catalog/maps/${id}/experiences`),
      this.get(`/v1/catalog/maps/${id}/alternators`).catch(() => ({ alternators: [] })),
    ]);
    return { experiences: exp.experiences || [], alternators: alt.alternators || [] };
  }

  async sponsor(): Promise<string> {
    if (this.features.sponsor) return String((await this.get('/v1/sponsor')).imageUrl || '');
    return getValue((await this.config()).text, SESSION_SECTION, SPONSOR_KEY) || '';
  }

  setSponsor(url: string) {
    return this.editConfig((text) => ({
      text: setValue(text, SESSION_SECTION, SPONSOR_KEY, url),
      message: url ? '스폰서 이미지를 바꿨습니다.' : '스폰서 이미지를 지웠습니다.',
    }));
  }

  rotation(): Promise<Json> {
    return this.get('/v1/rotation');
  }

  async scorePeriod(): Promise<number | null> {
    const v = getValue((await this.config()).text, SCORE_SECTION, SCORE_KEY);
    return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
  }

  setScorePeriod(seconds: number) {
    return this.editConfig((text) => ({
      text: setValue(text, SCORE_SECTION, SCORE_KEY, seconds),
      message: `점수 주기를 ${seconds}초로 바꿨습니다. 다음 매치부터 적용됩니다.`,
    }));
  }

  addRotationEntry(selection: RotationSelection) {
    return this.editRotation((entries) => {
      entries.push(formatRotationEntry(selection));
      return `${selection.map}을(를) ${entries.length}번째 항목으로 추가했습니다.`;
    });
  }

  removeRotationEntry(index: number) {
    return this.editRotation((entries) => {
      if (index < 0 || index >= entries.length) throw new RconError(400, 'bad_index', `로테이션 ${index + 1}번 항목이 없습니다.`);
      entries.splice(index, 1);
      return `로테이션 ${index + 1}번 항목을 지웠습니다.`;
    });
  }

  moveRotationEntry(index: number, to: number) {
    return this.editRotation((entries) => {
      if (index < 0 || index >= entries.length || to < 0 || to >= entries.length) {
        throw new RconError(400, 'bad_index', `로테이션 ${index + 1}번 항목을 ${to + 1}번 자리로 옮길 수 없습니다.`);
      }
      entries.splice(to, 0, ...entries.splice(index, 1));
      return `로테이션 ${index + 1}번 항목을 ${to + 1}번 자리로 옮겼습니다.`;
    });
  }

  async setNextMap(selection: RotationSelection) {
    const live = await this.rotation();
    const now: number = (live.entries || []).findIndex((e: Json) => e.status === 'now');
    return this.editRotation((entries) => {
      let index = entries.findIndex((raw, i) => i !== now && sameSelection(parseRotationEntry(raw), selection));
      let nowAfter = now;
      if (index < 0) {
        entries.push(formatRotationEntry(selection));
        index = entries.length - 1;
      } else if (now > index) {
        nowAfter = now - 1;
      }
      const restLast = entries.length - 2;
      const slot = nowAfter < 0 || nowAfter >= restLast ? 0 : nowAfter + 1;
      if (index !== slot) entries.splice(slot, 0, ...entries.splice(index, 1));
      return `다음 맵을 ${selection.map}(으)로 정했습니다 (로테이션 ${slot + 1}번).`;
    });
  }

  setRotationSettings(settings: RotationSettings) {
    const parts = [
      settings.enabled !== undefined ? `로테이션을 ${settings.enabled ? '켰습니다' : '껐습니다'}.` : '',
      settings.mode ? `순서를 ${settings.mode === 'random' ? '무작위' : '순서대로'}로 바꿨습니다.` : '',
    ];
    return this.editConfig((text) => ({ text: setRotationSettingsInDoc(text, settings), message: parts.filter(Boolean).join(' ') }));
  }

  async jumpToRotation(index: number) {
    const raw = rotationEntriesInDoc((await this.config()).text)[index];
    if (!raw) throw new RconError(400, 'bad_index', `로테이션 ${index + 1}번 항목이 없습니다.`);
    const entry = parseRotationEntry(raw);
    await this.setNextMap(entry);
    await this.endMatch();
    return { message: `매치를 끝냈습니다. 종료 화면이 지나면 ${entry.map}(으)로 이동합니다.` };
  }

  editRotation(mutate: (entries: string[]) => string) {
    return this.editConfig((text) => {
      const entries = rotationEntriesInDoc(text);
      const message = mutate(entries);
      return { text: setRotationInDoc(text, entries), message };
    });
  }

  async config(): Promise<ConfigDoc> {
    const d = await this.get('/v1/config');
    return {
      revision: d.revision || '',
      writable: d.writable !== false,
      text: d.text || '',
      sections: d.sections || [],
      warnings: d.warnings || [],
    };
  }

  validateConfig(text: string): Promise<ConfigResult> {
    return this.configResult('POST', '/v1/config/validate', text);
  }

  applyConfig(text: string, { revision, force = false }: { revision?: string; force?: boolean } = {}): Promise<ConfigResult> {
    return this.configResult('PUT', '/v1/config', text, revision, { force: force ? 'true' : undefined });
  }

  async configResult(method: string, path: string, text: string, revision?: string, query?: RequestOptions['query']): Promise<ConfigResult> {
    const headers: Record<string, string> = revision ? { 'If-Match': `"${revision}"` } : {};
    try {
      const r = await this.request(method, path, { text, headers, query });
      return { status: r.status, ...r.body, ok: r.body.ok !== false };
    } catch (err) {
      if (err instanceof RconError && (err.status === 412 || err.status === 422) && err.body) {
        return { status: err.status, ...(err.body as Json), ok: false };
      }
      throw err;
    }
  }

  async editConfig(mutate: (text: string) => { text: string; message?: string }): Promise<Json & { unchanged?: boolean; message?: string }> {
    const live = await this.config();
    const { text, message } = mutate(live.text);
    if (text === live.text) return { unchanged: true, message: message || '바뀐 내용이 없습니다.' };
    const result = await this.applyConfig(text, { revision: live.revision });
    if (!result.ok) {
      const detail = (result.errors || []).map((e) => e.message || `${e.key}: ${e.code}`).join(' ')
        || result.error?.message || '';
      throw new RconError(result.status, result.status === 412 ? 'revision_conflict' : 'config_rejected', result.status === 412
        ? `편집하는 사이 서버 설정이 바뀌었습니다. 다시 시도하세요. ${detail}`.trim()
        : `서버가 설정을 거부했습니다. ${detail}`.trim(), result);
    }
    const outcome = (result.outcomes || []).map((o) => o.detail).find(Boolean);
    return { ...result, message: [message, outcome].filter(Boolean).join(' ') || undefined };
  }
}

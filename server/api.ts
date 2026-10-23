import { hasRole } from './auth.ts';
import { HttpError, readBody, errorMessage, requireText, tokenMatches } from './http.ts';
import type { Router, Handler, SseHub, Body } from './http.ts';
import { WHITELIST_MODES } from './store.ts';
import type { Store, WhitelistMode, FeedRequest } from './store.ts';
import type { Role, Session } from './auth.ts';
import type { RconClient, RconError, MapSelection } from './rcon.ts';
import type { RotationSelection, RotationSettings } from './inidoc.ts';
import type { Poller } from './poller.ts';
import type { FeedProcessor, FeedBatch } from './feed.ts';
import type { Config } from './config.ts';
import type { Discord } from './discord.ts';
import type { SteamProfiles } from './steam.ts';
import { SETTING_FIELDS, readSettings, writeSettings, lockedSettings, appliesSettings, presetValues } from './settings.ts';
import type { IncomingMessage } from 'node:http';

const MAX_CHAT = 256;
const MAX_REASON = 200;
const FEED_BODY_LIMIT = 1024 * 1024;
const STEAM_ID = /^\d{17}$/;

function requireSteamId(id: string): string {
  if (!STEAM_ID.test(id)) throw new HttpError(400, 'bad_steam_id', 'SteamID64(17자리 숫자)가 아닙니다');
  return id;
}

function readSelection(body: Body): MapSelection {
  const sel: MapSelection = { map: requireText(body.map, '맵', 128) };
  if (Array.isArray(body.experiences) && body.experiences.length) sel.experiences = body.experiences.map(String);
  if (body.lighting) sel.lighting = String(body.lighting);
  if (body.zoneAlternator) sel.zoneAlternator = String(body.zoneAlternator);
  return sel;
}

const selectionForRotation = (sel: MapSelection): RotationSelection => ({ ...sel, alternator: sel.zoneAlternator });

interface ApiContext {
  discord: Discord;
  steam: SteamProfiles;
  rcon: RconClient;
  store: Store;
  poller: Poller;
  feed: FeedProcessor;
  hub: SseHub;
  config: Config;
}

export function registerApi(router: Router, ctx: ApiContext): void {
  const { rcon, store, poller, feed, hub, config, discord, steam } = ctx;
  const catalogCache: { at: number; data: Awaited<ReturnType<RconClient['catalog']>> | null } = { at: 0, data: null };

  const ROTATION_ACTIONS = new Set(['rotation_add', 'rotation_set_next', 'rotation_move', 'rotation_remove', 'rotation_settings', 'rotation_jump', 'change_map', 'end_match', 'settings_update', 'config_apply']);
  const act = async <T>(session: Session, action: string, target: string | null, detail: unknown, fn: () => Promise<T>): Promise<T> => {
    try {
      const result = await fn();
      if (ROTATION_ACTIONS.has(action)) poller.refreshRotation();
      hub.broadcast('action', store.logAction(session.name, action, target, detail, true));
      return result;
    } catch (err) {
      hub.broadcast('action', store.logAction(session.name, action, target, detail, false, errorMessage(err)));
      throw err;
    }
  };

  const route = (method: string, path: string, role: Role, handler: Handler) => router.add(method, path, { role }, handler);

  route('GET', '/api/kills', 'viewer', ({ query }) => store.recentKills({
    limit: Number(query.get('limit')) || 100,
    before: Number(query.get('before')) || undefined,
    search: query.get('search') || undefined,
  }));

  route('GET', '/api/engagements', 'viewer', ({ query }) => store.recentEngagements({
    limit: Number(query.get('limit')) || 30,
    minKills: Number(query.get('minKills')) || config.engagementMinKills,
  }));
  route('GET', '/api/engagements/:id', 'viewer', ({ params }) => store.engagementKills(Number(params.id)));
  route('GET', '/api/weapons', 'viewer', ({ query }) => {
    const hours = Number(query.get('hours')) || 24;
    return store.weaponStats({ since: Date.now() - hours * 3600_000 });
  });
  route('GET', '/api/match-events', 'viewer', () => store.recentMatchEvents(100));
  route('GET', '/api/cash-history', 'viewer', () => poller.cash);
  route('GET', '/api/steam/profiles', 'viewer', ({ query }) => {
    const ids = [...new Set((query.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length > 200 || !ids.every((id) => STEAM_ID.test(id))) throw new HttpError(400, 'bad_steam_id', 'SteamID64 목록이 올바르지 않습니다 (최대 200개)');
    return steam.lookup(ids);
  });
  route('GET', '/api/players/:steamId/profile', 'viewer', ({ params }) => store.playerProfile(requireSteamId(params.steamId)));

  route('POST', '/api/players/:steamId/message', 'mod', async ({ params, body, session }) => {
    const id = requireSteamId(params.steamId);
    const message = requireText(body.message, '메시지', MAX_CHAT);
    return act(session, 'message', id, { message, name: body.name }, () => rcon.message(id, message));
  });

  route('POST', '/api/players/:steamId/kick', 'mod', async ({ params, body, session }) => {
    const id = requireSteamId(params.steamId);
    const reason = requireText(body.reason, '사유', MAX_REASON);
    return act(session, 'kick', id, { reason, name: body.name }, () => rcon.kick(id, reason));
  });

  route('POST', '/api/players/:steamId/kill', 'mod', async ({ params, body, session }) => {
    const id = requireSteamId(params.steamId);
    return act(session, 'kill', id, { name: body.name }, () => rcon.kill(id));
  });

  route('POST', '/api/players/:steamId/faction', 'mod', async ({ params, body, session }) => {
    const id = requireSteamId(params.steamId);
    const faction = requireText(body.faction, '진영', 64);
    if (rcon.capabilities && !rcon.features.changeTeam) throw new HttpError(501, 'no_route', '이 서버 빌드는 진영 이동을 지원하지 않습니다');
    return act(session, 'move_faction', id, { faction, name: body.name }, () => rcon.changeFaction(id, faction));
  });

  route('POST', '/api/broadcast', 'mod', async ({ body, session }) => {
    const message = requireText(body.message, '공지', MAX_CHAT);
    return act(session, 'broadcast', null, { message }, () => rcon.broadcast(message));
  });

  route('GET', '/api/bans', 'viewer', async () => {
    return { bans: await rcon.bans(), pending: store.pendingBans() };
  });

  route('POST', '/api/bans', 'mod', async ({ body, session }) => {
    const id = requireSteamId(String(body.steamId ?? '').trim());
    const reason = requireText(body.reason, '사유', MAX_REASON, { optional: true });
    const online = poller.players.some((p) => p.steamId === id);
    if (!online && body.queueIfOffline !== false) {
      return act(session, 'ban_queued', id, { reason }, async () => {
        store.addPendingBan(id, reason, session.name);
        return { queued: true, message: '접속 중이 아니라 대기열에 넣었습니다. 입장하는 순간 밴·킥합니다.' };
      });
    }
    return act(session, 'ban', id, { reason }, async () => {
      try {
        const r = await rcon.ban(id, reason);
        await rcon.kick(id, reason || 'Banned').catch(() => {});
        return { queued: false, ...r };
      } catch (err) {
        if ((err as RconError).code === 'player_not_found' && body.queueIfOffline !== false) {
          store.addPendingBan(id, reason, session.name);
          return { queued: true, message: '게임이 밴을 거부해(접속 중 아님) 대기열에 넣었습니다.' };
        }
        throw err;
      }
    });
  });

  route('DELETE', '/api/bans/:steamId', 'mod', async ({ params, session }) => {
    const id = requireSteamId(params.steamId);
    return act(session, 'unban', id, null, async () => {
      const r = await rcon.unban(id);
      const stillBanned = (await rcon.bans()).some((b) => b.steamId === id);
      if (stillBanned) {
        throw new HttpError(502, 'unban_not_applied', '서버가 해제 완료라고 답했지만 밴 목록에 아직 남아 있습니다. 다시 시도하거나 설정 문서를 확인하세요.');
      }
      return { ...r, verified: true };
    });
  });

  route('DELETE', '/api/pending-bans/:steamId', 'mod', async ({ params, session }) => {
    const id = requireSteamId(params.steamId);
    return act(session, 'ban_queue_remove', id, null, async () => ({ removed: store.removePendingBan(id) }));
  });

  route('GET', '/api/links', 'viewer', () => store.links());

  route('DELETE', '/api/links/:steamId', 'mod', ({ params, session }) => {
    const id = requireSteamId(params.steamId);
    return act(session, 'unlink', id, null, async () => {
      store.unlink(id);
      poller.nudge();
      return { ok: true };
    });
  });

  route('GET', '/api/streamers', 'viewer', () => store.discordLinks());

  route('DELETE', '/api/streamers/:discordId', 'mod', ({ params, session }) => {
    const link = store.discordLink('discord', params.discordId);
    if (!link) throw new HttpError(404, 'not_found', '인증된 스트리머가 아닙니다');
    return act(session, 'streamer_remove', link.steamId, { discordId: link.discordId, discord: link.discordName },
      () => discord.revoke(link.discordId));
  });

  route('GET', '/api/entry-gate', 'viewer', () => poller.entryGateView());

  route('PUT', '/api/entry-gate', 'admin', ({ body, session }) => {
    const prev = store.entryGate();
    if (!body.active) {
      return act(session, 'entry_gate_stop', null, null, async () => {
        store.setEntryGate({ ...prev, active: false, startedAt: null, openAt: null });
        return poller.entryGateView();
      });
    }
    const threshold = Number(body.threshold);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) throw new HttpError(400, 'bad_threshold', '스트리머 인원은 1~100명입니다');
    const minutes = Number(body.minutes ?? 0);
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 180) throw new HttpError(400, 'bad_minutes', '자동 해제 시간은 0~180분입니다 (0은 끄기)');
    const message = requireText(body.message, '안내 문구', MAX_REASON);
    const now = Date.now();
    return act(session, 'entry_gate_start', null, { threshold, minutes, message }, async () => {
      store.setEntryGate({ active: true, threshold, message, startedAt: prev.active ? prev.startedAt : now, openAt: minutes ? now + minutes * 60_000 : null });
      poller.nudge();
      return poller.entryGateView();
    });
  });

  route('GET', '/api/whitelist', 'viewer', () => ({ ...store.whitelist(), bans: store.whitelistBans() }));

  route('PUT', '/api/whitelist', 'admin', ({ body, session }) => {
    const mode = String(body.mode ?? '') as WhitelistMode;
    if (!WHITELIST_MODES.includes(mode)) throw new HttpError(400, 'bad_mode', '모드는 off, kick, ban 중 하나입니다');
    const message = requireText(body.message, '안내 문구', MAX_REASON);
    return act(session, 'whitelist_update', mode, { message }, async () => {
      store.setWhitelist({ mode, message });
      poller.nudge();
      return { mode, message };
    });
  });

  route('GET', '/api/reserved', 'viewer', async ({ session }) => {
    const live = await rcon.reservedSlots();
    let inDoc = null;
    if (hasRole(session, 'admin')) inDoc = await rcon.reservedInDoc().catch(() => null);
    return { live, inDoc, liveRoutes: rcon.features.reservedRoutes, streamers: store.discordLinks().map((l) => l.steamId) };
  });

  const editReserved = (session: Session, id: string, present: boolean) =>
    act(session, present ? 'reserved_add' : 'reserved_remove', id, { via: rcon.features.reservedRoutes ? 'route' : 'config' },
      () => rcon.setReserved(id, present));
  route('POST', '/api/reserved', 'admin', ({ body, session }) => editReserved(session, requireSteamId(String(body.steamId ?? '').trim()), true));
  route('DELETE', '/api/reserved/:steamId', 'admin', ({ params, session }) => {
    const id = requireSteamId(params.steamId);
    if (store.discordLink('steam', id)) {
      throw new HttpError(409, 'streamer_slot', '인증된 스트리머의 예약 슬롯입니다. 빼려면 연동 탭에서 스트리머를 해제하세요');
    }
    return editReserved(session, id, false);
  });

  route('GET', '/api/rotation', 'viewer', () => rcon.rotation());

  route('GET', '/api/catalog', 'viewer', async () => {
    if (catalogCache.data && Date.now() - catalogCache.at < 10 * 60_000) return catalogCache.data;
    catalogCache.data = await rcon.catalog();
    catalogCache.at = Date.now();
    return catalogCache.data;
  });

  route('GET', '/api/catalog/maps/:id', 'viewer', ({ params }) => rcon.mapOptions(params.id));

  route('POST', '/api/match/map', 'admin', ({ body, session }) => {
    const sel = readSelection(body);
    return act(session, 'change_map', sel.map, sel, () => rcon.changeMap(sel));
  });
  route('POST', '/api/match/end', 'admin', ({ session }) => act(session, 'end_match', null, null, () => rcon.endMatch()));
  route('POST', '/api/match/restart', 'admin', ({ session }) => act(session, 'restart_match', null, null, () => rcon.restartMatch()));
  route('POST', '/api/world/lighting', 'admin', ({ body, session }) => {
    const lighting = requireText(body.lighting, '조명', 128);
    return act(session, 'set_lighting', lighting, null, () => rcon.setLighting(lighting));
  });

  const requireConfigWrite = () => {
    if (rcon.capabilities && !rcon.features.configDocument) {
      throw new HttpError(501, 'config_read_only', '이 서버는 설정 문서 쓰기를 막아 두어 로테이션을 편집할 수 없습니다');
    }
  };
  const rotationIndex = (v: unknown, field = '항목 번호') => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'bad_index', `${field}가 올바르지 않습니다`);
    return n;
  };
  route('POST', '/api/rotation', 'admin', ({ body, session }) => {
    requireConfigWrite();
    const sel = readSelection(body);
    return act(session, 'rotation_add', sel.map, sel, () => rcon.addRotationEntry(selectionForRotation(sel)));
  });
  route('POST', '/api/rotation/next', 'admin', ({ body, session }) => {
    requireConfigWrite();
    const sel = readSelection(body);
    return act(session, 'rotation_set_next', sel.map, sel, () => rcon.setNextMap(selectionForRotation(sel)));
  });
  route('POST', '/api/rotation/:index/move', 'admin', ({ params, body, session }) => {
    requireConfigWrite();
    const index = rotationIndex(params.index);
    const to = rotationIndex(body.to, '옮길 자리');
    return act(session, 'rotation_move', String(index + 1), { to: to + 1 }, () => rcon.moveRotationEntry(index, to));
  });
  route('PUT', '/api/rotation/settings', 'admin', ({ body, session }) => {
    requireConfigWrite();
    const settings: RotationSettings = {};
    if (body.enabled !== undefined) settings.enabled = !!body.enabled;
    if (body.mode !== undefined) {
      if (body.mode !== 'ordered' && body.mode !== 'random') throw new HttpError(400, 'bad_mode', '순서는 ordered 또는 random입니다');
      settings.mode = body.mode;
    }
    if (!Object.keys(settings).length) throw new HttpError(400, 'missing_field', '바꿀 값이 없습니다');
    return act(session, 'rotation_settings', null, settings, () => rcon.setRotationSettings(settings));
  });
  route('POST', '/api/rotation/:index/jump', 'admin', async ({ params, session }) => {
    requireConfigWrite();
    const index = rotationIndex(params.index);
    const live = await rcon.rotation();
    const entry = (live.entries || [])[index];
    if (!entry) throw new HttpError(400, 'bad_index', `로테이션 ${index + 1}번 항목이 없습니다`);
    if (entry.status === 'now') throw new HttpError(409, 'already_now', '이미 진행 중인 맵입니다. 다시 불러오려면 매치 재시작을 쓰세요');
    if (entry.denied) throw new HttpError(409, 'denied_entry', '서버가 거부한 항목이라 이동할 수 없습니다');
    if (live.enabled === false) throw new HttpError(409, 'rotation_off', '로테이션이 꺼져 있으면 매치가 끝나도 지금 맵을 다시 불러옵니다. 먼저 로테이션을 켜세요');
    return act(session, 'rotation_jump', String(index + 1), { map: entry.map }, () => rcon.jumpToRotation(index));
  });
  route('DELETE', '/api/rotation/:index', 'admin', ({ params, session }) => {
    requireConfigWrite();
    const index = rotationIndex(params.index);
    return act(session, 'rotation_remove', String(index + 1), null, () => rcon.removeRotationEntry(index));
  });

  const scoreRange = (): [number, number] => {
    const { min, max } = poller.status?.scoreTick ?? {};
    return Number.isFinite(min) && Number.isFinite(max) ? [min!, max!] : [18, 30];
  };
  route('GET', '/api/score-period', 'viewer', async () => ({
    saved: await rcon.scorePeriod(),
    current: poller.status?.scoreTick?.current ?? null,
    range: scoreRange(),
  }));
  route('PUT', '/api/score-period', 'admin', ({ body, session }) => {
    requireConfigWrite();
    const [min, max] = scoreRange();
    const value = Number(body.value);
    if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(400, 'bad_score_period', `점수 주기는 ${min}~${max}초 사이 정수입니다`);
    return act(session, 'score_period', `${value}초`, null, () => rcon.setScorePeriod(value));
  });

  route('GET', '/api/sponsor', 'viewer', async () => ({ url: await rcon.sponsor() }));
  route('PUT', '/api/sponsor', 'admin', ({ body, session }) => {
    requireConfigWrite();
    const url = requireText(body.url, '이미지 주소', 300, { optional: true });
    if (url && URL.parse(url)?.protocol !== 'https:') throw new HttpError(400, 'bad_url', '이미지 주소는 https:// 로 시작해야 합니다');
    return act(session, 'sponsor_update', null, { url }, () => rcon.setSponsor(url));
  });

  route('GET', '/api/config', 'admin', () => rcon.config());

  route('POST', '/api/config/validate', 'admin', ({ body }) => {
    const text = requireText(body.text, '설정 문서', 64 * 1024);
    return rcon.validateConfig(text);
  });

  route('PUT', '/api/config', 'admin', ({ body, session }) => {
    const text = requireText(body.text, '설정 문서', 64 * 1024);
    if (!body.revision) throw new HttpError(400, 'missing_revision', '불러온 리비전 없이 적용할 수 없습니다. 먼저 문서를 불러오세요.');
    return act(session, 'config_apply', null, { revision: body.revision, force: !!body.force }, async () => {
      const result = await rcon.applyConfig(text, { revision: body.revision, force: !!body.force });
      if (result.ok === false) throw Object.assign(new HttpError(result.status, 'config_rejected', result.status === 412
        ? '다른 관리자가 먼저 수정했습니다. 다시 불러온 뒤 적용하세요.'
        : '서버가 값을 거부해 아무것도 적용되지 않았습니다.', result));
      return result;
    });
  });

  route('GET', '/api/settings', 'admin', async () => {
    const doc = await rcon.config();
    return {
      revision: doc.revision,
      writable: doc.writable && (!rcon.capabilities || rcon.features.configDocument),
      fields: SETTING_FIELDS,
      values: readSettings(doc.text),
      locked: lockedSettings(doc.sections),
      applies: appliesSettings(doc.sections),
      presets: store.configPresets(),
    };
  });

  route('PUT', '/api/settings', 'admin', ({ body, session }) => {
    requireConfigWrite();
    if (!body.revision) throw new HttpError(400, 'missing_revision', '불러온 리비전 없이 적용할 수 없습니다. 먼저 설정을 불러오세요.');
    if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) throw new HttpError(400, 'missing_field', '바꿀 값이 없습니다');
    writeSettings('', body.values);
    return act(session, 'settings_update', null, { keys: Object.keys(body.values) }, async () => {
      const live = await rcon.config();
      const { text, keys } = writeSettings(live.text, body.values);
      if (!keys.length) return { ok: true, status: 200, message: '바뀐 값이 없습니다.' };
      const result = await rcon.applyConfig(text, { revision: body.revision });
      if (result.ok === false) {
        throw new HttpError(result.status, 'config_rejected', result.status === 412
          ? '다른 관리자가 먼저 수정했습니다. 다시 불러온 뒤 적용하세요.'
          : '서버가 값을 거부해 아무것도 적용되지 않았습니다.', result);
      }
      return result;
    });
  });

  const presetName = (v: string) => requireText(v, '프리셋 이름', 40);
  route('PUT', '/api/settings/presets/:name', 'admin', ({ params, body, session }) => {
    const name = presetName(params.name);
    const values = presetValues(body.values && typeof body.values === 'object' ? body.values : {});
    if (!Object.keys(values).length) throw new HttpError(400, 'missing_field', '저장할 값이 없습니다');
    return act(session, 'preset_save', name, null, async () => {
      const list = store.configPresets().filter((p) => p.name !== name);
      list.push({ name, values, savedAt: Date.now(), savedBy: session.name });
      list.sort((a, b) => a.name.localeCompare(b.name));
      store.setConfigPresets(list);
      return list;
    });
  });
  route('DELETE', '/api/settings/presets/:name', 'admin', ({ params, session }) => {
    const name = presetName(params.name);
    return act(session, 'preset_delete', name, null, async () => {
      const list = store.configPresets().filter((p) => p.name !== name);
      store.setConfigPresets(list);
      return list;
    });
  });

  route('GET', '/api/audit', 'admin', async () => {
    let rconAudit = null;
    let rconError = null;
    try {
      rconAudit = await rcon.audit(200);
    } catch (err) {
      rconError = errorMessage(err);
    }
    return {
      dashboard: store.actions({ limit: 300 }),
      rcon: rconAudit,
      rconError,
      feedRequests: store.feedRequests(300),
      feedEvents: store.feedEvents(300),
    };
  });

  const ingest: Handler = async ({ req }) => {
    const log: FeedRequest = { at: Date.now(), peer: req.socket.remoteAddress, status: 0 };
    try {
      const result = await ingestBatch(req, log);
      store.logFeedRequest({ ...log, status: 200, accepted: result.accepted, duplicates: result.duplicates });
      return result;
    } catch (err) {
      const e = err as HttpError;
      store.logFeedRequest({ ...log, status: e.status ?? 500, code: e.code, error: errorMessage(err) });
      throw err;
    }
  };
  const ingestBatch = async (req: IncomingMessage, log: FeedRequest) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokenMatches(token, config.feedToken)) {
      feed.rejected++;
      throw new HttpError(401, 'bad_token', 'invalid feed token');
    }
    const buf = await readBody(req, FEED_BODY_LIMIT);
    let body: FeedBatch;
    try {
      body = JSON.parse(buf.toString('utf8'));
    } catch {
      feed.rejected++;
      throw new HttpError(400, 'bad_json', 'invalid JSON');
    }
    if (Array.isArray(body?.events)) log.events = body.events.length;
    const result = feed.ingest(body, Date.now());
    if (!result.ok) throw new HttpError(400, 'bad_batch', result.error);
    return result;
  };
  router.add('POST', '/api/ingest/events', { public: true, rawBody: true }, ingest);
  router.add('POST', '/api/ingest/events/api/ingest/events', { public: true, rawBody: true }, ingest);
}


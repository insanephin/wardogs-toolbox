import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import type { Store, DiscordLink, StreamerPair } from './store.ts';
import type { Fleet, ServerRuntime } from './fleet.ts';
import type { Kv } from './kv.ts';
import { sqlNow, joinUrl } from './link.ts';
import type { Account } from './link.ts';
import { HttpError, readJson, errorMessage, requireText, tokenMatches } from './http.ts';
import type { Router, Handler } from './http.ts';

type Provider = 'chzzk' | 'steam';

const TICKET_TTL_MS = 10 * 60_000;
const TICKET_GRACE_MS = 60_000;
const WAIT_MS = 25_000;
const SYNC_MS = 60_000;
const SYNC_PER_RUN = 3;
export const DISCORD_ID = /^\d{5,20}$/;
export const DISCORD_BOT_PERMISSIONS = String(1024 | 2048);
export const botInstallConfigured = ({ discord: c }: Config) => !!(c.botClientId && c.botClientSecret && c.botRedirectUrl);

export type VerifyResult = 'proven' | 'reserved' | 'queued' | 'taken' | 'expired';

interface Ticket {
  serverId: number;
  discordId: string;
  discordName: string;
  expires: number;
  version: number;
  result: VerifyResult | null;
  chzzk?: Account;
  steam?: Account;
  claimed: boolean;
  done: boolean;
}

interface DiscordOptions {
  config: Config;
  store: Store;
  fleet: Fleet;
  kv: Kv;
}

const ticketKey = (id: string) => `discord:ticket:${id}`;
const userKey = (discordId: string) => `discord:ticket-of:${discordId}`;

const reservedId = (entry: unknown) => (typeof entry === 'string' ? entry : String((entry as { steamId?: unknown })?.steamId ?? ''));

export function createDiscord({ config, store, fleet, kv }: DiscordOptions) {
  const secret = config.discord.botSecret;
  const configured = !!(secret && config.publicUrl);
  const busy = new Set<string>();
  const waiters = new Map<string, Set<() => void>>();
  const locks = new Map<string, Promise<unknown>>();

  const load = (id: string) => kv.get<Ticket>(ticketKey(id));
  const save = (id: string, t: Ticket) => kv.set(ticketKey(id), t, t.expires - Date.now() + TICKET_GRACE_MS);

  function wake(id: string) {
    for (const fn of waiters.get(id) ?? []) fn();
    waiters.delete(id);
  }

  function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    const tail = run.finally(() => {
      if (locks.get(id) === tail) locks.delete(id);
    });
    locks.set(id, tail);
    return run;
  }

  async function settle(id: string, t: Ticket, result: VerifyResult, done: boolean) {
    t.version++;
    t.result = result;
    t.done = done;
    await save(id, t);
    wake(id);
  }

  async function newTicket(serverId: number, discordId: string, discordName: string): Promise<{ id: string; expires: number }> {
    const previous = await kv.get<string>(userKey(discordId));
    if (previous) {
      await kv.del(ticketKey(previous));
      wake(previous);
    }
    const id = randomBytes(24).toString('base64url');
    const expires = Date.now() + TICKET_TTL_MS;
    await save(id, { serverId, discordId, discordName, expires, version: 0, result: null, claimed: false, done: false });
    await kv.set(userKey(discordId), id, TICKET_TTL_MS + TICKET_GRACE_MS);
    return { id, expires };
  }

  async function ticketView(id: string, t: Ticket | null) {
    if (!t) return { version: Number.MAX_SAFE_INTEGER, result: 'expired', chzzkName: null, steamName: null, done: true };
    if (!t.done && t.expires < Date.now()) await settle(id, t, 'expired', true);
    return { version: t.version, result: t.result, chzzkName: t.chzzk?.name ?? null, steamName: t.steam?.name ?? null, done: t.done };
  }

  async function wait(id: string, after: number) {
    const t = await load(id);
    if (t && !t.done && t.version <= after && t.expires > Date.now()) {
      await new Promise<void>((resolve) => {
        const set = waiters.get(id) ?? new Set();
        waiters.set(id, set);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          set.delete(done);
          if (!set.size) waiters.delete(id);
          resolve();
        }, Math.min(WAIT_MS, t.expires - Date.now() + 100));
        set.add(done);
      });
      return ticketView(id, await load(id));
    }
    return ticketView(id, t);
  }

  async function reserve(srv: ServerRuntime, steamId: string, present: boolean, detail: Record<string, unknown>): Promise<{ ok: boolean; pendingRestart?: boolean }> {
    const key = `${srv.id}:${steamId}`;
    if (busy.has(key)) return { ok: false };
    busy.add(key);
    const action = present ? 'reserved_add' : 'reserved_remove';
    try {
      const r = await srv.rcon.setReserved(steamId, present);
      srv.emit('action', srv.store.logAction('discord', action, steamId, { ...detail, via: r.via }, true));
      return { ok: true, pendingRestart: 'pendingRestart' in r && r.pendingRestart };
    } catch (err) {
      if (!present) srv.emit('action', srv.store.logAction('discord', action, steamId, detail, false, errorMessage(err)));
      throw err;
    } finally {
      busy.delete(key);
    }
  }

  async function grant(srv: ServerRuntime, link: Pick<DiscordLink, 'steamId' | 'discordId' | 'discordName'>, why?: string) {
    try {
      const r = await reserve(srv, link.steamId, true, { discordId: link.discordId, discord: link.discordName, ...(why && { why }) });
      if (r.ok) srv.store.markDiscordReserved(link.steamId, null);
      return r;
    } catch (err) {
      srv.store.markDiscordReserved(link.steamId, errorMessage(err));
      return { ok: false };
    }
  }

  const usable = (t: Ticket | null): t is Ticket => !!t && !t.claimed && !t.done && t.expires > Date.now();
  const valid = async (id: string) => usable(await load(id));

  async function release(srv: ServerRuntime, steamId: string) {
    if (srv.store.discordLink('steam', steamId)) return srv.store.removeDiscordRelease(steamId);
    const r = await reserve(srv, steamId, false, { why: 'relinked' });
    if (r.ok) srv.store.removeDiscordRelease(steamId);
  }

  async function reject(id: string, t: Ticket, provider: Provider): Promise<VerifyResult> {
    delete t[provider];
    await settle(id, t, 'taken', false);
    return 'taken';
  }

  const step = (id: string, provider: Provider, account: Account) => locked(id, () => stepNow(id, provider, account));

  async function stepNow(id: string, provider: Provider, account: Account): Promise<VerifyResult> {
    const t = await load(id);
    if (!usable(t)) return 'expired';
    const srv = fleet.get(t.serverId);
    if (!srv) {
      await settle(id, t, 'expired', true);
      return 'expired';
    }
    t[provider] = account;
    let pair: StreamerPair | null;
    if (t.chzzk && t.steam) {
      const free = [store.linkByAccount('steam', t.steam.id), store.linkByAccount('chzzk', t.chzzk.id)]
        .every((l) => !l || (l.steamId === t.steam!.id && l.chzzkChannelId === t.chzzk!.id));
      if (!free) return reject(id, t, provider);
      pair = { steamId: t.steam.id, steamName: t.steam.name, chzzkChannelId: t.chzzk.id, chzzkName: t.chzzk.name };
    } else if (t.steam) {
      pair = store.linkByAccount('steam', t.steam.id)
        ?? { steamId: t.steam.id, steamName: t.steam.name, chzzkChannelId: null, chzzkName: null };
    } else {
      pair = store.linkByAccount(provider, account.id);
      if (!pair) {
        await settle(id, t, 'proven', false);
        return 'proven';
      }
    }
    if (store.discordSteamTaken(pair.steamId, t.discordId)) return reject(id, t, provider);

    t.claimed = true;
    t.steam = { id: pair.steamId, name: pair.steamName ?? pair.steamId };
    if (pair.chzzkChannelId) {
      t.chzzk = { id: pair.chzzkChannelId, name: pair.chzzkName ?? pair.chzzkChannelId };
      store.linkIfFree(t.steam, t.chzzk, sqlNow());
    }
    await save(id, t);
    const prev = srv.store.discordLink('discord', t.discordId);
    srv.store.saveDiscordLink(t.discordId, t.discordName, pair, Date.now());
    console.log(`[디스코드] #${srv.id} ${srv.name} 화이트리스트 등록: ${t.discordName} (${t.discordId}) → ${t.chzzk ? `치지직 ${t.chzzk.name} · ` : ''}스팀 ${t.steam.name} (${t.steam.id})`);
    if (prev && prev.steamId !== pair.steamId && prev.reserved) {
      srv.store.addDiscordRelease(prev.steamId);
      release(srv, prev.steamId).catch(() => {});
    }
    const r = prev?.steamId === pair.steamId && prev.reserved ? { ok: true } : await grant(srv, { ...t, steamId: pair.steamId });
    const result = r.ok ? 'reserved' : 'queued';
    await settle(id, t, result, true);
    return result;
  }

  async function revoke(srv: ServerRuntime, discordId: string) {
    const link = srv.store.discordLink('discord', discordId);
    if (!link) return { ok: true };
    if (link.reserved) await srv.rcon.setReserved(link.steamId, false);
    srv.store.removeDiscordLink(discordId);
    return { ok: true, steamId: link.steamId };
  }

  async function sync() {
    for (const srv of fleet.all()) await syncServer(srv).catch(() => {});
  }

  async function syncServer(srv: ServerRuntime) {
    const rcon = srv.rcon;
    if (!rcon.capabilities) return;
    const links = srv.store.discordLinks();
    const releases = srv.store.discordReleases();
    if (!links.length && !releases.length) return;
    let have: Set<string>;
    try {
      have = new Set(rcon.features.reservedRoutes ? (await rcon.reservedSlots()).map(reservedId) : await rcon.reservedInDoc());
    } catch {
      return;
    }
    let budget = SYNC_PER_RUN;
    for (const steamId of releases) {
      if (!have.has(steamId)) {
        srv.store.removeDiscordRelease(steamId);
        continue;
      }
      if (!budget--) return;
      await release(srv, steamId).catch(() => {});
    }
    for (const link of links) {
      if (have.has(link.steamId)) {
        if (!link.reserved) srv.store.markDiscordReserved(link.steamId, null);
        continue;
      }
      if (!budget--) break;
      await grant(srv, link, link.reserved ? 'restored' : undefined);
    }
  }

  const guildServers = (guildId: string) => (DISCORD_ID.test(guildId) ? store.serverIdsByDiscordGuild(guildId) : [])
    .map((id) => fleet.get(id))
    .filter((s): s is ServerRuntime => !!s && !s.demo);

  const bot = (handler: Handler): Handler => (ctx) => {
    const auth = ctx.req.headers.authorization || '';
    if (!configured || !tokenMatches(auth.startsWith('Bearer ') ? auth.slice(7) : '', secret)) {
      throw new HttpError(401, 'bad_token', 'invalid bot secret');
    }
    return handler(ctx);
  };

  function register(router: Router) {
    router.add('GET', '/api/discord/guilds/:guildId/servers', { public: true }, bot(({ params }) =>
      guildServers(params.guildId).map((s) => ({ id: s.id, name: s.name }))));

    router.add('POST', '/api/discord/panel', { public: true, rawBody: true }, bot(async ({ req }) => {
      const body = await readJson(req, 4096);
      const list = guildServers(String(body.guildId ?? ''));
      if (!list.length) throw new HttpError(404, 'guild_not_linked', '이 디스코드 서버에 연결된 게임 서버가 없습니다. 대시보드 \'연결 정보\' 탭에서 디스코드 서버 연결을 먼저 해주세요.');
      const wanted = body.serverId == null || body.serverId === '' ? null : Number(body.serverId);
      const srv = wanted == null ? (list.length === 1 ? list[0] : undefined) : list.find((s) => s.id === wanted);
      if (!srv && wanted == null) throw new HttpError(400, 'choose_server', '이 디스코드 서버에 연결된 게임 서버가 여러 개입니다. 서버 옵션에서 골라주세요.');
      if (!srv) throw new HttpError(404, 'guild_not_linked', '이 디스코드 서버에 연결되지 않은 게임 서버입니다.');
      return { id: srv.id, name: srv.name, joinUrl: srv.joinCode ? joinUrl(srv.joinCode) : null };
    }));

    router.add('POST', '/api/discord/tickets', { public: true, rawBody: true }, bot(async ({ req }) => {
      const body = await readJson(req, 4096);
      const discordId = String(body.discordId ?? '');
      if (!DISCORD_ID.test(discordId)) throw new HttpError(400, 'bad_discord_id', 'invalid discordId');
      const discordName = requireText(body.discordName, 'discordName', 100);
      const srv = fleet.get(Number(body.serverId));
      if (!srv) throw new HttpError(404, 'unknown_server', 'unknown server');
      const { id, expires } = await newTicket(srv.id, discordId, discordName);
      const link = srv.store.discordLink('discord', discordId);
      const q = new URLSearchParams({ t: id });
      return {
        ticket: id,
        urls: { chzzk: `${config.publicUrl}/discord/verify/chzzk?${q}`, steam: `${config.publicUrl}/discord/verify/steam?${q}` },
        expiresAt: expires,
        link: link && { steamId: link.steamId, steamName: link.steamName, chzzkName: link.chzzkName, reserved: link.reserved },
        server: { name: srv.name, joinUrl: srv.joinCode ? joinUrl(srv.joinCode) : null },
      };
    }));

    router.add('GET', '/api/discord/tickets/:ticket', { public: true }, bot(({ params, query }) =>
      wait(params.ticket, Number(query.get('after')) || 0)));
  }

  function start() {
    if (!configured) return;
    setInterval(() => sync().catch(() => {}), SYNC_MS).unref();
  }

  return { configured, register, bot, valid, step, start, revoke, sync };
}

export type Discord = ReturnType<typeof createDiscord>;

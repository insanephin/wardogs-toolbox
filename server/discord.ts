import { randomBytes } from 'node:crypto';
import type { Config } from './config.ts';
import type { Store, DiscordLink, StreamerPair } from './store.ts';
import type { Fleet, ServerRuntime } from './fleet.ts';
import { hasRole } from './auth.ts';
import { sqlNow, joinUrl } from './link.ts';
import type { Account } from './link.ts';
import { HttpError, readJson, errorMessage, requireText, tokenMatches } from './http.ts';
import type { Router, Handler } from './http.ts';

type Provider = 'chzzk' | 'steam';

const TICKET_TTL_MS = 10 * 60_000;
const MAX_TICKETS = 10_000;
const WAIT_MS = 25_000;
const SYNC_MS = 60_000;
const SYNC_PER_RUN = 3;
const DISCORD_ID = /^\d{5,20}$/;

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
  waiters: Set<() => void>;
}

interface DiscordOptions {
  config: Config;
  store: Store;
  fleet: Fleet;
  superadmins: Set<string>;
}

const reservedId = (entry: unknown) => (typeof entry === 'string' ? entry : String((entry as { steamId?: unknown })?.steamId ?? ''));

export function createDiscord({ config, store, fleet, superadmins }: DiscordOptions) {
  const secret = config.discord.botSecret;
  const configured = !!(secret && config.publicUrl);
  const tickets = new Map<string, Ticket>();
  const busy = new Set<string>();

  function settle(t: Ticket, result: VerifyResult, done: boolean) {
    t.version++;
    t.result = result;
    t.done = done;
    for (const wake of t.waiters) wake();
    t.waiters.clear();
  }

  function newTicket(serverId: number, discordId: string, discordName: string): string {
    const now = Date.now();
    for (const [k, t] of tickets) {
      if (t.expires < now || t.discordId === discordId) {
        if (!t.done) settle(t, 'expired', true);
        tickets.delete(k);
      }
    }
    while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value as string);
    const id = randomBytes(24).toString('base64url');
    tickets.set(id, { serverId, discordId, discordName, expires: now + TICKET_TTL_MS, version: 0, result: null, claimed: false, done: false, waiters: new Set() });
    return id;
  }

  const ticketView = (t: Ticket | undefined) => {
    if (!t) return { version: Number.MAX_SAFE_INTEGER, result: 'expired', chzzkName: null, steamName: null, done: true };
    if (!t.done && t.expires < Date.now()) settle(t, 'expired', true);
    return { version: t.version, result: t.result, chzzkName: t.chzzk?.name ?? null, steamName: t.steam?.name ?? null, done: t.done };
  };

  async function wait(id: string, after: number) {
    const t = tickets.get(id);
    if (t && !t.done && t.version <= after && t.expires > Date.now()) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          t.waiters.delete(wake);
          resolve();
        }, Math.min(WAIT_MS, t.expires - Date.now() + 100));
        t.waiters.add(wake);
      });
    }
    return ticketView(t);
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

  const valid = (id: string) => {
    const t = tickets.get(id);
    return !!t && !t.claimed && !t.done && t.expires > Date.now();
  };

  async function release(srv: ServerRuntime, steamId: string) {
    if (srv.store.discordLink('steam', steamId)) return srv.store.removeDiscordRelease(steamId);
    const r = await reserve(srv, steamId, false, { why: 'relinked' });
    if (r.ok) srv.store.removeDiscordRelease(steamId);
  }

  function reject(t: Ticket, provider: Provider): VerifyResult {
    delete t[provider];
    settle(t, 'taken', false);
    return 'taken';
  }

  async function step(id: string, provider: Provider, account: Account): Promise<VerifyResult> {
    const t = tickets.get(id);
    if (!t || !valid(id)) return 'expired';
    const srv = fleet.get(t.serverId);
    if (!srv) {
      settle(t, 'expired', true);
      return 'expired';
    }
    t[provider] = account;
    let pair: StreamerPair | null;
    if (t.chzzk && t.steam) {
      const free = [store.linkByAccount('steam', t.steam.id), store.linkByAccount('chzzk', t.chzzk.id)]
        .every((l) => !l || (l.steamId === t.steam!.id && l.chzzkChannelId === t.chzzk!.id));
      if (!free) return reject(t, provider);
      pair = { steamId: t.steam.id, steamName: t.steam.name, chzzkChannelId: t.chzzk.id, chzzkName: t.chzzk.name };
    } else if (t.steam) {
      pair = store.linkByAccount('steam', t.steam.id)
        ?? { steamId: t.steam.id, steamName: t.steam.name, chzzkChannelId: null, chzzkName: null };
    } else {
      pair = store.linkByAccount(provider, account.id);
      if (!pair) {
        settle(t, 'proven', false);
        return 'proven';
      }
    }
    if (store.discordSteamTaken(pair.steamId, t.discordId)) return reject(t, provider);

    t.claimed = true;
    t.steam = { id: pair.steamId, name: pair.steamName ?? pair.steamId };
    if (pair.chzzkChannelId) {
      t.chzzk = { id: pair.chzzkChannelId, name: pair.chzzkName ?? pair.chzzkChannelId };
      store.linkIfFree(t.steam, t.chzzk, sqlNow());
    }
    const prev = srv.store.discordLink('discord', t.discordId);
    srv.store.saveDiscordLink(t.discordId, t.discordName, pair, Date.now());
    console.log(`[디스코드] #${srv.id} ${srv.name} 화이트리스트 등록: ${t.discordName} (${t.discordId}) → ${t.chzzk ? `치지직 ${t.chzzk.name} · ` : ''}스팀 ${t.steam.name} (${t.steam.id})`);
    if (prev && prev.steamId !== pair.steamId && prev.reserved) {
      srv.store.addDiscordRelease(prev.steamId);
      release(srv, prev.steamId).catch(() => {});
    }
    const r = prev?.steamId === pair.steamId && prev.reserved ? { ok: true } : await grant(srv, { ...t, steamId: pair.steamId });
    const result = r.ok ? 'reserved' : 'queued';
    settle(t, result, true);
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

  function register(router: Router) {
    const bot = (handler: Handler): Handler => (ctx) => {
      const auth = ctx.req.headers.authorization || '';
      if (!configured || !tokenMatches(auth.startsWith('Bearer ') ? auth.slice(7) : '', secret)) {
        throw new HttpError(401, 'bad_token', 'invalid bot secret');
      }
      return handler(ctx);
    };

    router.add('GET', '/api/discord/servers', { public: true }, bot(({ query }) => {
      const discordId = String(query.get('discordId') ?? '');
      if (!DISCORD_ID.test(discordId)) throw new HttpError(400, 'bad_discord_id', 'invalid discordId');
      const steamId = store.identityOwner('discord', discordId);
      if (!steamId) return { linked: false, servers: [] };
      const servers = superadmins.has(steamId)
        ? fleet.all()
        : store.memberships(steamId).filter((m) => hasRole(m.role, 'admin')).flatMap((m) => fleet.get(m.serverId) ?? []);
      return { linked: true, servers: servers.map((s) => ({ id: s.id, name: s.name })) };
    }));

    router.add('POST', '/api/discord/tickets', { public: true, rawBody: true }, bot(async ({ req }) => {
      const body = await readJson(req, 4096);
      const discordId = String(body.discordId ?? '');
      if (!DISCORD_ID.test(discordId)) throw new HttpError(400, 'bad_discord_id', 'invalid discordId');
      const discordName = requireText(body.discordName, 'discordName', 100);
      const srv = fleet.get(Number(body.serverId));
      if (!srv) throw new HttpError(404, 'unknown_server', 'unknown server');
      const id = newTicket(srv.id, discordId, discordName);
      const link = srv.store.discordLink('discord', discordId);
      const q = new URLSearchParams({ t: id });
      return {
        ticket: id,
        urls: { chzzk: `${config.publicUrl}/discord/verify/chzzk?${q}`, steam: `${config.publicUrl}/discord/verify/steam?${q}` },
        expiresAt: tickets.get(id)!.expires,
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

  return { configured, register, valid, step, start, revoke, sync };
}

export type Discord = ReturnType<typeof createDiscord>;

import { HttpError, requireText, requireSteamId } from './http.ts';
import type { Router, SseHub } from './http.ts';
import { isRole } from './auth.ts';
import type { Session } from './auth.ts';
import { IDENTITY_PROVIDERS } from './store.ts';
import type { Store, Role, IdentityProvider } from './store.ts';
import { panelName } from './fleet.ts';
import type { Fleet, ServerRuntime } from './fleet.ts';
import type { SteamProfiles } from './steam.ts';
import type { Provider } from './link.ts';
import { probeRcon, throttleProbe, requireRconUrl } from './target.ts';

const MAX_CREATED = 5;

interface ServersContext {
  store: Store;
  fleet: Fleet;
  hub: SseHub;
  steam: SteamProfiles;
  configured: Record<Provider, boolean>;
}

export function roleOf(store: Store, session: Session, serverId: number, fleet: Fleet): Role | null {
  if (session.guest) return fleet.get(serverId)?.demo ? 'owner' : null;
  return session.superadmin ? 'owner' : store.memberRole(serverId, session.steamId);
}

export function registerServers(router: Router, { store, fleet, hub, steam, configured }: ServersContext): void {
  const summary = (srv: ServerRuntime, role: Role) => ({
    id: srv.id,
    name: srv.name,
    role,
    public: srv.public,
    passworded: srv.poller.passworded,
    joinCode: srv.joinCode,
    online: srv.poller.online,
    gameName: srv.poller.status?.serverName ?? null,
    players: srv.poller.players.length,
  });

  const myServers = (session: Session) => {
    if (session.guest) return fleet.all().filter((s) => s.demo).map((s) => summary(s, 'owner'));
    if (session.superadmin) return fleet.all().map((s) => summary(s, 'owner'));
    return store.memberships(session.steamId).flatMap(({ serverId, role }) => {
      const srv = fleet.get(serverId);
      return srv ? [summary(srv, role)] : [];
    });
  };

  const log = (srv: ServerRuntime, session: Session, action: string, target: string | null, detail: unknown) =>
    srv.emit('action', srv.store.logAction(session.name, action, target, detail, true));

  router.add('GET', '/api/me', {}, ({ session }) => {
    const user = store.user(session.steamId);
    return { steamId: session.steamId, name: session.name, avatar: user?.avatar ?? null, superadmin: session.superadmin, demo: !!session.guest, servers: myServers(session) };
  });

  router.add('GET', '/api/servers', {}, ({ session }) => myServers(session));

  router.add('POST', '/api/servers', {}, async ({ body, session }) => {
    const url = requireRconUrl(body.url);
    const password = requireText(body.password, 'RCON 비밀번호', 200);
    if (!session.superadmin && store.servers().filter((s) => s.createdBy === session.steamId).length >= MAX_CREATED) {
      throw new HttpError(409, 'too_many_servers', `서버는 한 사람당 ${MAX_CREATED}개까지 추가할 수 있습니다`);
    }
    if (fleet.all().some((s) => s.rcon.baseUrl === url)) throw new HttpError(409, 'server_exists', '이미 등록된 RCON 주소입니다. 그 서버 소유자에게 멤버 추가를 요청하세요');
    throttleProbe(session);
    const { gameName } = await probeRcon(url, password, { allowPrivate: session.superadmin });
    const name = panelName(gameName);
    const row = store.createServer(name, url, password, session.steamId);
    const srv = fleet.add(row);
    log(srv, session, 'server_create', name, { url: !!url });
    return summary(srv, 'owner');
  });

  router.add('GET', '/api/s/:sid/server', { role: 'viewer' }, ({ srv, role }) => ({
    ...summary(srv, role),
    createdAt: store.server(srv.id)?.createdAt ?? null,
  }));

  router.add('DELETE', '/api/s/:sid/server', { role: 'owner' }, ({ body, session, srv }) => {
    if (String(body.confirm ?? '') !== srv.name) throw new HttpError(400, 'confirm_mismatch', '확인용 서버 이름이 맞지 않습니다');
    fleet.remove(srv.id);
    store.deleteServer(srv.id);
    console.log(`[서버] ${session.name}(${session.steamId})이(가) 서버 #${srv.id} "${srv.name}"을(를) 삭제했습니다`);
    return { ok: true };
  });

  router.add('GET', '/api/s/:sid/members', { role: 'admin' }, ({ srv }) => store.members(srv.id));

  const owners = (serverId: number) => store.members(serverId).filter((m) => m.role === 'owner').length;

  router.add('PUT', '/api/s/:sid/members/:steamId', { role: 'owner' }, async ({ params, body, session, srv }) => {
    const steamId = requireSteamId(params.steamId);
    const role = body.role;
    if (!isRole(role)) throw new HttpError(400, 'bad_role', '권한은 viewer, mod, admin, owner 중 하나입니다');
    const prev = store.memberRole(srv.id, steamId);
    if (prev === 'owner' && role !== 'owner' && owners(srv.id) <= 1) throw new HttpError(409, 'last_owner', '마지막 소유자는 권한을 낮출 수 없습니다');
    if (!store.user(steamId)) {
      const profile = (await steam.lookup([steamId]))[steamId];
      store.touchUser(steamId, profile?.name ?? null, profile?.avatar ?? null, false);
    }
    store.setMember(srv.id, steamId, role, session.steamId);
    log(srv, session, prev ? 'member_role' : 'member_add', steamId, { role, from: prev, name: store.user(steamId)?.name });
    return store.members(srv.id);
  });

  router.add('DELETE', '/api/s/:sid/members/:steamId', { role: 'owner' }, ({ params, session, srv }) => {
    const steamId = params.steamId;
    const prev = store.memberRole(srv.id, steamId);
    if (!prev) throw new HttpError(404, 'not_found', '이 서버의 멤버가 아닙니다');
    if (prev === 'owner' && owners(srv.id) <= 1) throw new HttpError(409, 'last_owner', '마지막 소유자는 뺄 수 없습니다');
    store.removeMember(srv.id, steamId);
    hub.close((c) => c.serverId === srv.id && c.session.steamId === steamId && !c.session.superadmin);
    log(srv, session, 'member_remove', steamId, { role: prev, name: store.user(steamId)?.name });
    return store.members(srv.id);
  });

  const providers = () => Object.fromEntries(IDENTITY_PROVIDERS.map((p) => [p, configured[p]]));

  router.add('GET', '/api/account', {}, ({ session }) => ({
    steamId: session.steamId,
    name: session.name,
    identities: store.identities(session.steamId),
    providers: providers(),
  }));

  router.add('DELETE', '/api/account/identities/:provider', {}, ({ params, session }) => {
    const provider = params.provider as IdentityProvider;
    if (!IDENTITY_PROVIDERS.includes(provider)) throw new HttpError(400, 'bad_provider', '모르는 로그인 방식입니다');
    store.unlinkIdentity(session.steamId, provider);
    return { identities: store.identities(session.steamId), providers: providers() };
  });
}

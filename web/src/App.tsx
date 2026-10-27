import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ComponentType, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useStore, setState, getState, can, colorsFrom, withEngagements, currentServer, pickServer, selectServer } from './lib/store.ts';
import { api, errorMessage, scoped, refreshMe } from './lib/api.ts';
import type { Action, CashHistory, Capabilities, Engagement, FeedEvent, FeedStatus, Kill, Live, Me, Report, Role } from './lib/types.ts';
import { toast, useToasts } from './lib/toast.ts';
import { ModalHost } from './lib/modal.tsx';
import { fmtAgo } from './lib/format.ts';
import { useNow, Avatar, setPageActionSlot } from './components/common.tsx';
import Overview from './views/Overview.tsx';
import Players from './views/Players.tsx';
import Feed from './views/Feed.tsx';
import Moderation from './views/Moderation.tsx';
import Links from './views/Links.tsx';
import Match from './views/Match.tsx';
import Config from './views/Config.tsx';
import Settings from './views/Settings.tsx';
import Audit from './views/Audit.tsx';
import Server from './views/Server.tsx';
import Reports from './views/Reports.tsx';
import Members from './views/Members.tsx';
import { openCreateServer } from './components/createServer.tsx';
import Account from './views/Account.tsx';
import { ROLE_LABEL } from './lib/labels.ts';
import { Spinner } from './components/spinner.tsx';
import { IconButton, Icon } from './components/iconButton.tsx';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faChevronDown, faPlus, faCheck, faRightFromBracket, faGauge, faUsers, faCrosshairs, faMap, faLink, faBan, faFlag,
  faPlug, faSliders, faFileCode, faClockRotateLeft, faUserShield,
} from '@fortawesome/free-solid-svg-icons';

const KILL_BUFFER = 300;

interface Page {
  id: string;
  label: string;
  role: Role;
  icon?: IconDefinition;
  View?: ComponentType;
  tabs?: Page[];
  hidden?: boolean;
  // Fit the viewport and scroll only inside the table. 'split' = grid-main layout with a side column.
  fill?: 'card' | 'split';
}

const VIEWS: Page[] = [
  { id: 'overview', label: '개요', icon: faGauge, View: Overview, role: 'viewer' },
  { id: 'players', label: '플레이어', icon: faUsers, View: Players, role: 'viewer', fill: 'card' },
  { id: 'feed', label: '전투 기록', icon: faCrosshairs, View: Feed, role: 'viewer', fill: 'split' },
  { id: 'match', label: '경기 운영', icon: faMap, View: Match, role: 'viewer' },
  { id: 'access', label: '접속 관리', role: 'viewer', tabs: [
    { id: 'links', label: '계정 연동·화이트리스트', icon: faLink, View: Links, role: 'viewer', fill: 'split' },
    { id: 'moderation', label: '밴·예약 슬롯', icon: faBan, View: Moderation, role: 'viewer', fill: 'split' },
  ] },
  { id: 'reports', label: '신고', icon: faFlag, View: Reports, role: 'viewer', fill: 'card' },
  { id: 'system', label: '설정', role: 'viewer', tabs: [
    { id: 'server', label: '연결 정보', icon: faPlug, View: Server, role: 'viewer' },
    { id: 'settings', label: '간편 설정', icon: faSliders, View: Settings, role: 'admin' },
    { id: 'config', label: '설정 문서', icon: faFileCode, View: Config, role: 'admin' },
    { id: 'audit', label: '감사 로그', icon: faClockRotateLeft, View: Audit, role: 'admin', fill: 'card' },
    { id: 'members', label: '관리자', icon: faUserShield, View: Members, role: 'admin', fill: 'card' },
  ] },
  { id: 'account', label: '내 계정', View: Account, role: 'viewer', hidden: true },
];

function resolve(hash: string) {
  const allowed = VIEWS.filter((v) => can(v.role)).map((v) => (v.tabs ? { ...v, tabs: v.tabs.filter((t) => can(t.role)) } : v));
  const entry = allowed.find((v) => v.id === hash || v.tabs?.some((t) => t.id === hash)) || allowed[0]!;
  const tab = entry.tabs ? entry.tabs.find((t) => t.id === hash) || entry.tabs[0] : null;
  return { allowed, entry, tab };
}

export default function App() {
  const me = useStore((s) => s.me);
  const serverId = useStore((s) => s.serverId);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api<Me>('GET', '/api/me')
      .then((m) => setState({ me: m, serverId: pickServer(m) }))
      .catch(() => {})
      .finally(() => setChecked(true));
  }, []);

  return (
    <>
      {!checked ? <div className="boot"><Spinner size={64} scan /></div>
        : !me ? <Login />
        : serverId != null ? <Shell key={`${me.steamId}:${serverId}`} me={me} />
        : <NoServer me={me} />}
      <ModalHost />
      <Toasts />
    </>
  );
}

function Toasts() {
  const list = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}${t.out ? ' out' : ''}`} role={t.kind === 'error' ? 'alert' : 'status'}>{t.message}</div>
      ))}
    </div>
  );
}

const loginError = (code: string): string => {
  switch (code) {
    case 'denied': return '이 스팀 계정은 아직 어떤 서버의 멤버도 아닙니다. 서버 소유자에게 SteamID 등록을 요청하세요';
    case 'cancelled': return '스팀 로그인을 취소했습니다';
    case 'expired': return '로그인 시간이 지났습니다. 다시 시도해주세요';
    case 'unconfigured': return '서버에 스팀 로그인 설정이 없습니다';
    default: return '스팀 로그인에 실패했습니다. 잠시 후 다시 시도해주세요';
  }
};

const STEAM_LOGIN = '/panel/login/steam';

function Login() {
  const [error] = useState(() => {
    const code = new URLSearchParams(location.search).get('login');
    return code ? loginError(code) : '';
  });
  useEffect(() => {
    if (!error) location.replace(STEAM_LOGIN);
    else if (location.search) history.replaceState(null, '', '/panel');
  }, [error]);
  if (!error) return <div className="boot"><Spinner size={64} scan /></div>;
  return (
    <div className="login-wrap">
      <div className="login-card">
        <p className="login-error" role="alert">{error}</p>
        <a className="btn btn-primary btn-block" href={STEAM_LOGIN}>스팀으로 다시 로그인</a>
        <a className="btn btn-block" href="/">처음으로</a>
      </div>
    </div>
  );
}

const logout = async () => {
  await api('POST', '/api/logout', {}).catch(() => {});
  location.assign('/');
};

function NoServer({ me }: { me: Me }) {
  useEffect(() => {
    if (location.search) history.replaceState(null, '', location.pathname);
    refreshMe().catch(() => {});
  }, []);
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-row">
          <div className="topbar-left" />
          <span className="server-name">서버 추가</span>
          <div className="topbar-right"><MeBox me={me} role={null} /></div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="hub">
        <div className="card">
          <div className="card-body stack hub-empty">
            <p>아직 관리하는 서버가 없습니다.</p>
            <p className="muted small">내 게임 서버를 직접 추가하거나, 이미 있는 서버라면 소유자에게 내 SteamID를 알려주세요: <span className="mono">{me.steamId}</span></p>
            <div><button className="btn btn-primary" type="button" onClick={openCreateServer}>새 서버 추가</button></div>
          </div>
        </div>
        <Account />
      </main>
    </div>
  );
}

function MeBox({ me, role, active }: { me: Me; role: Role | null; active?: boolean }) {
  return (
    <div className="me">
      {role ? (
        <a href="#account" className={`me-link${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} title="내 계정">
          <Avatar src={me.avatar} /><span className="me-name">{me.name}</span>
        </a>
      ) : <span className="me-link"><Avatar src={me.avatar} /><span className="me-name">{me.name}</span></span>}
      <IconButton icon={faRightFromBracket} label={me.demo ? '데모 나가기' : '로그아웃'} className="btn-ghost" onClick={logout} />
    </div>
  );
}

function useLiveStream() {
  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;
    const on = <T,>(name: string, fn: (data: T) => void) => source!.addEventListener(name, (e) => fn(JSON.parse((e as MessageEvent).data)));

    (async () => {
      try {
        const [kills, engagements, events] = await Promise.all([
          api<Kill[]>('GET', '/api/kills?limit=150'),
          api<Engagement[]>('GET', '/api/engagements?limit=40'),
          api<FeedEvent[]>('GET', '/api/match-events'),
        ]);
        setState({ kills, engagements: new Map(engagements.map((g) => [g.id, g])), matchEvents: events });
      } catch (err) {
        if (getState().me) toast(`초기 데이터 로드 실패: ${errorMessage(err)}`, 'error');
      }
      if (cancelled) return;
      source = new EventSource(scoped('/api/stream'));
      on<Live>('live', (live) => setState((s) => ({ live, colors: colorsFrom(live, s.colors) })));
      on<Capabilities>('capabilities', (caps) => setState({ caps }));
      on<Kill>('kill', (k) => setState((s) => ({ kills: [k, ...s.kills].slice(0, KILL_BUFFER) })));
      on<Engagement>('engagement', (g) => setState((s) => ({ engagements: withEngagements(s.engagements, [g]) })));
      on<FeedEvent>('matchEvent', (ev) => setState((s) => ({ matchEvents: [ev, ...s.matchEvents].slice(0, 200) })));
      on<FeedStatus>('feed', (feed) => setState((s) => (s.live ? { live: { ...s.live, feed } } : {})));
      on<Action>('action', (a) => setState({ lastAction: a }));
      on<{ matchKey: string | null; point: CashHistory['points'][number] }>('cash', ({ matchKey, point }) => setState((s) => ({
        cash: { matchKey, points: s.cash?.matchKey === matchKey ? [...s.cash.points, point].slice(-360) : [point] },
      })));
      on<Report>('report', (r) => {
        setState({ lastReport: r });
        toast(`새 신고: ${r.targetName}`, 'warn');
      });
      source.onerror = () => setState({ streamDown: true });
      source.onopen = () => setState({ streamDown: false });
    })();

    return () => {
      cancelled = true;
      source?.close();
      setState({ live: null, caps: null, kills: [], engagements: new Map(), matchEvents: [], lastAction: null, lastReport: null, cash: null, streamDown: false });
    };
  }, []);
}

const subscribeHash = (fn: () => void) => (window.addEventListener('hashchange', fn), () => window.removeEventListener('hashchange', fn));
const useHash = () => useSyncExternalStore(subscribeHash, () => location.hash.slice(1));

function Shell({ me }: { me: Me }) {
  useLiveStream();
  const hash = useHash();
  const mainRef = useRef<HTMLElement>(null);
  const { allowed, entry, tab } = resolve(hash);
  const page = tab || entry;
  const role = currentServer()?.role ?? null;
  const stale = useStore((s) => !!s.live && !s.live.online);

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
    mainRef.current?.parentElement?.scrollTo(0, 0);
  }, [page.id]);

  const navItem = (v: Page) => (
    <a key={v.id} href={`#${v.id}`} className={v.id === page.id ? 'active' : undefined} aria-current={v.id === page.id ? 'page' : undefined}>
      {v.icon ? <Icon icon={v.icon} className="side-icon" fixedWidth /> : null}<span>{v.label}</span>
    </a>
  );

  return (
    <div className="app">
      <aside className="side">
        <div className="side-head"><ServerPicker me={me} /></div>
        <nav className="side-nav" aria-label="메뉴">
          {allowed.filter((v) => !v.tabs && !v.hidden).map(navItem)}
          {allowed.filter((v) => v.tabs?.length).map((v) => (
            <div key={v.id} className="side-group" role="group" aria-label={v.label}>
              <div className="side-label" aria-hidden="true">{v.label}</div>
              {v.tabs!.map(navItem)}
            </div>
          ))}
        </nav>
        <div className="side-foot"><MeBox me={me} role={role} active={page.id === 'account'} /></div>
      </aside>
      <div className={stale ? 'app-main is-stale' : 'app-main'}>
        {me.demo ? <div className="demo-banner" role="note">데모 체험 중입니다. 가상의 게임 서버라 버튼을 눌러도 실제 서버에는 영향이 없고, 6시간마다 처음 상태로 돌아갑니다.</div> : null}
        <header className="page-head">
          <h1>{page.label}</h1>
          <div className="page-head-right">
            <div className="page-actions" ref={setPageActionSlot} />
            <Conn />
          </div>
        </header>
        <main id="main" tabIndex={-1} ref={mainRef} className={page.fill ? `main-fill main-fill-${page.fill}` : undefined}>
          {page.View ? <div key={page.id} className="page-body"><page.View /></div> : null}
        </main>
      </div>
    </div>
  );
}

function ServerPicker({ me }: { me: Me }) {
  const current = useStore(currentServer);
  const gameName = useStore((s) => s.live?.status?.serverName);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[aria-current="true"], button')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const move = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...menuRef.current!.querySelectorAll<HTMLElement>('button')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const pick = (id: number) => {
    setOpen(false);
    if (id !== current?.id) selectServer(id);
  };

  const name = current?.name ?? gameName ?? '서버 연결 대기';
  return (
    <div className="server-switch" ref={rootRef}
      onBlur={(e) => e.relatedTarget && !rootRef.current?.contains(e.relatedTarget) && setOpen(false)}>
      <button ref={triggerRef} type="button" className="server-trigger" aria-haspopup="true" aria-expanded={open} title={gameName}
        onClick={() => setOpen(!open)}>
        <span className="server-name">{name}</span>
        <Icon icon={faChevronDown} className="server-chev" />
      </button>
      {open ? (
        <div ref={menuRef} className="server-menu" role="group" aria-label="서버 전환" onKeyDown={move}>
          {me.servers.map((s) => (
            <button key={s.id} type="button" className="server-item" aria-current={s.id === current?.id} onClick={() => pick(s.id)}>
              <span className="server-item-name">
                <span className="server-name">{s.name}</span>
                {s.id === current?.id ? <Icon icon={faCheck} className="server-check" /> : null}
              </span>
              <span className="server-item-meta">
                <span className={`conn ${s.online ? 'conn-up' : 'conn-down'}`}><span className="dot" aria-hidden="true" />{s.online ? `${s.players}명 접속` : '연결 끊김'}</span>
                <span className="tag">{ROLE_LABEL[s.role]}</span>
              </span>
            </button>
          ))}
          {me.demo ? null : (
            <>
              <div className="server-menu-sep" aria-hidden="true" />
              <button type="button" className="server-item server-add" onClick={() => {
                setOpen(false);
                openCreateServer();
              }}>
                <Icon icon={faPlus} fixedWidth />새 서버 추가
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Conn() {
  const live = useStore((s) => s.live);
  const streamDown = useStore((s) => s.streamDown);
  useNow();
  let cls = 'conn conn-wait';
  let state = '연결 중';
  let title: string | undefined;
  if (live) {
    const up = live.online && !streamDown;
    cls = `conn ${up ? 'conn-up' : 'conn-down'}`;
    title = live.online ? `RCON 연결됨 · ${live.intervalMs / 1000}초 주기` : `RCON 끊김: ${live.lastError?.message ?? ''}`;
    state = live.online ? '연결됨' : live.lastPollAt ? `끊김 · ${fmtAgo(live.lastPollAt)}` : '끊김';
  } else if (streamDown) {
    cls = 'conn conn-down';
  }
  return (
    <div className={cls} title={title}>
      <span className="dot" aria-hidden="true" />
      <span className={cls.includes('conn-down') ? 'conn-text' : undefined}>{state}</span>
    </div>
  );
}

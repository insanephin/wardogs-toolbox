import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ComponentType } from 'react';
import { useStore, setState, getState, can, colorsFrom, withEngagements } from './lib/store.ts';
import { api, errorMessage } from './lib/api.ts';
import type { Action, Capabilities, Engagement, FeedEvent, FeedStatus, Kill, Live, Me, Report, Role } from './lib/types.ts';
import { toast, useToasts } from './lib/toast.ts';
import { ModalHost } from './lib/modal.tsx';
import { fmtAgo } from './lib/format.ts';
import { useNow } from './components/common.tsx';
import Overview from './views/Overview.tsx';
import Players from './views/Players.tsx';
import Feed from './views/Feed.tsx';
import Moderation from './views/Moderation.tsx';
import Links from './views/Links.tsx';
import Match from './views/Match.tsx';
import Config from './views/Config.tsx';
import Audit from './views/Audit.tsx';
import Server from './views/Server.tsx';
import Reports from './views/Reports.tsx';
import { Spinner } from './components/spinner.tsx';

const ROLE_LABEL: Record<Role, string> = { viewer: '뷰어', mod: '모더레이터', admin: '관리자' };
const KILL_BUFFER = 300;

interface Page {
  id: string;
  label: string;
  role: Role;
  View?: ComponentType;
  tabs?: Page[];
}

const VIEWS: Page[] = [
  { id: 'overview', label: '개요', View: Overview, role: 'viewer' },
  { id: 'players', label: '플레이어', View: Players, role: 'viewer' },
  { id: 'feed', label: '전투 기록', View: Feed, role: 'viewer' },
  { id: 'match', label: '경기 운영', View: Match, role: 'viewer' },
  { id: 'access', label: '접속 관리', role: 'viewer', tabs: [
    { id: 'links', label: '계정 연동·화이트리스트', View: Links, role: 'viewer' },
    { id: 'moderation', label: '밴·예약 슬롯', View: Moderation, role: 'viewer' },
  ] },
  { id: 'reports', label: '신고', View: Reports, role: 'viewer' },
  { id: 'system', label: '설정', role: 'viewer', tabs: [
    { id: 'server', label: '연결 정보', View: Server, role: 'viewer' },
    { id: 'config', label: '서버 설정', View: Config, role: 'admin' },
    { id: 'audit', label: '감사 로그', View: Audit, role: 'admin' },
  ] },
];

function resolve(hash: string, me: Me) {
  const allowed = VIEWS.filter((v) => can(v.role, me)).map((v) => (v.tabs ? { ...v, tabs: v.tabs.filter((t) => can(t.role, me)) } : v));
  const entry = allowed.find((v) => v.id === hash || v.tabs?.some((t) => t.id === hash)) || allowed[0]!;
  const tab = entry.tabs ? entry.tabs.find((t) => t.id === hash) || entry.tabs[0] : null;
  return { allowed, entry, tab };
}

export default function App() {
  const me = useStore((s) => s.me);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api<Me>('GET', '/api/me')
      .then((m) => setState({ me: m }))
      .catch(() => {})
      .finally(() => setChecked(true));
  }, []);

  return (
    <>
      {!checked ? <div className="boot"><Spinner /></div> : me ? <Shell key={me.name} me={me} /> : <Login />}
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

const LOGIN_ERRORS: Record<string, string> = {
  denied: '이 치지직 계정은 관리자 패널 권한이 없습니다',
  cancelled: '치지직 로그인을 취소했습니다',
  expired: '로그인 시간이 지났습니다. 다시 시도해주세요',
  failed: '치지직 로그인에 실패했습니다. 잠시 후 다시 시도해주세요',
  unconfigured: '서버에 치지직 앱 설정이 없습니다',
};

function Login() {
  const [error] = useState(() => {
    const code = new URLSearchParams(location.search).get('login');
    return code ? LOGIN_ERRORS[code] ?? LOGIN_ERRORS.failed! : '';
  });
  useEffect(() => {
    if (location.search) history.replaceState(null, '', '/rcon');
  }, []);
  return (
    <div className="login-wrap">
      <div className="login-card">
        {error ? <p className="login-error" role="alert">{error}</p> : null}
        <a className="btn btn-primary btn-block" href="/rcon/login">로그인</a>
      </div>
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
      source = new EventSource('/api/stream');
      on<Live>('live', (live) => setState((s) => ({ live, colors: colorsFrom(live, s.colors) })));
      on<Capabilities>('capabilities', (caps) => setState({ caps }));
      on<Kill>('kill', (k) => setState((s) => ({ kills: [k, ...s.kills].slice(0, KILL_BUFFER) })));
      on<Engagement>('engagement', (g) => setState((s) => ({ engagements: withEngagements(s.engagements, [g]) })));
      on<FeedEvent>('matchEvent', (ev) => setState((s) => ({ matchEvents: [ev, ...s.matchEvents].slice(0, 200) })));
      on<FeedStatus>('feed', (feed) => setState((s) => (s.live ? { live: { ...s.live, feed } } : {})));
      on<Action>('action', (a) => setState({ lastAction: a }));
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
      setState({ live: null, caps: null, kills: [], engagements: new Map(), matchEvents: [], lastAction: null, lastReport: null, streamDown: false });
    };
  }, []);
}

const subscribeHash = (fn: () => void) => (window.addEventListener('hashchange', fn), () => window.removeEventListener('hashchange', fn));
const useHash = () => useSyncExternalStore(subscribeHash, () => location.hash.slice(1));

function Shell({ me }: { me: Me }) {
  useLiveStream();
  const hash = useHash();
  const mainRef = useRef<HTMLElement>(null);
  const { allowed, entry, tab } = resolve(hash, me);
  const page = tab || entry;

  useEffect(() => {
    document.title = page.label;
    mainRef.current?.focus({ preventScroll: true });
  }, [page.id, page.label]);

  const logout = async () => {
    await api('POST', '/api/logout', {}).catch(() => {});
    setState({ me: null });
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-left">
          <nav className="nav" aria-label="메뉴">
            {allowed.map((v) => (
              <a key={v.id} href={`#${v.id}`} className={v.id === entry.id ? 'active' : undefined} aria-current={v.id === entry.id ? 'page' : undefined}>
                {v.label}
              </a>
            ))}
          </nav>
        </div>
        <ServerName />
        <div className="topbar-right">
          <Conn />
          <div className="me">
            <span>{me.name}</span><span className="muted small">{ROLE_LABEL[me.role]}</span>
            <button className="btn btn-ghost btn-sm" onClick={logout}>로그아웃</button>
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} ref={mainRef}>
        {entry.tabs && entry.tabs.length > 1 ? (
          <nav className="subtabs" aria-label={`${entry.label} 하위 메뉴`}>
            {entry.tabs.map((t) => (
              <a key={t.id} href={`#${t.id}`} className={t.id === tab?.id ? 'on' : undefined} aria-current={t.id === tab?.id ? 'page' : undefined}>{t.label}</a>
            ))}
          </nav>
        ) : null}
        {page.View ? <page.View key={page.id} /> : null}
      </main>
    </div>
  );
}

function ServerName() {
  const name = useStore((s) => s.live?.status?.serverName);
  return <span className="server-name">{name || '서버 연결 대기'}</span>;
}

function Conn() {
  const live = useStore((s) => s.live);
  const streamDown = useStore((s) => s.streamDown);
  useNow();
  let cls = 'conn';
  let state = '연결 중';
  let title: string | undefined;
  if (live) {
    const up = live.online && !streamDown;
    cls = `conn ${up ? 'conn-up' : 'conn-down'}`;
    title = live.online ? `RCON 연결됨 · ${live.intervalMs / 1000}초 주기` : `RCON 끊김: ${live.lastError?.message ?? ''}`;
    state = live.online ? '연결됨' : `끊김 · ${fmtAgo(live.lastPollAt)}`;
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

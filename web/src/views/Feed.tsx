import { useEffect, useRef, useState } from 'react';
import type { Engagement, Kill, WeaponStat } from '../lib/types.ts';
import { useStore, setState, withEngagements } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { fmtTime, fmtDist, pct } from '../lib/format.ts';
import { Card, Empty, useFactionColor } from '../components/common.tsx';
import { KillTable, EventDetail } from '../components/feedItems.tsx';
import { SortTable } from '../components/sortTable.tsx';
import { IconButton } from '../components/iconButton.tsx';
import { faXmark } from '@fortawesome/free-solid-svg-icons';

export default function Feed() {
  return (
    <div className="grid-main">
      <KillFeed />
      <div className="stack">
        <Engagements />
        <Card title="무기별 킬 (24시간)"><div className="card-body"><Weapons /></div></Card>
        <Card title="매치·입퇴장 이벤트"><div className="card-body"><div className="table-wrap"><MatchEvents /></div></div></Card>
      </div>
    </div>
  );
}

function KillFeed() {
  const kills = useStore((s) => s.kills);
  const matchKey = useStore((s) => s.live?.feed?.matchKey);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Kill[] | null>(null);
  const [filter, setFilter] = useState({ headshot: false, teamkill: false, currentMatch: false });
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    const q = searchText.trim();
    let stale = false;
    const t = setTimeout(async () => {
      const r = q ? await api<Kill[]>('GET', `/api/kills?limit=300&search=${encodeURIComponent(q)}`).catch(() => []) : null;
      if (stale) return;
      setSearch(q);
      setSearchResults(r);
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [searchText]);

  const loadMore = async () => {
    const last = (searchResults ?? kills).at(-1);
    if (!last) return;
    const older = await api<Kill[]>('GET', `/api/kills?limit=150&before=${last.receivedAt}${search ? `&search=${encodeURIComponent(search)}` : ''}`).catch(() => []);
    if (searchResults) setSearchResults((r) => [...(r ?? []), ...older]);
    else setState((s) => ({ kills: [...s.kills, ...older] }));
    if (!older.length) setExhausted(true);
  };

  let rows = searchResults ?? kills;
  if (filter.headshot) rows = rows.filter((k) => k.headshot);
  if (filter.teamkill) rows = rows.filter((k) => k.teamkill);
  if (filter.currentMatch) rows = rows.filter((k) => k.matchKey === matchKey);

  const check = (key: keyof typeof filter, label: string) => (
    <label className="check">
      <input type="checkbox" checked={filter[key]} onChange={(e) => setFilter((f) => ({ ...f, [key]: e.target.checked }))} />
      <span>{label}</span>
    </label>
  );

  return (
    <Card title="킬피드">
      <div className="toolbar">
        <input type="search" placeholder="이름, SteamID, 무기 검색" aria-label="킬피드 검색" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        {check('headshot', '헤드샷만')}
        {check('teamkill', '팀킬만')}
        {check('currentMatch', '이번 매치만')}
      </div>
      <div className="card-body">
        <div className="table-wrap">
          {rows.length
            ? <KillTable rows={rows} limit={400} />
            : <Empty>{search ? '검색 결과가 없습니다.' : '킬 이벤트가 없습니다.'}</Empty>}
        </div>
        <div className="center"><button className="btn btn-sm" type="button" disabled={exhausted} onClick={loadMore}>이전 기록 더 보기</button></div>
      </div>
    </Card>
  );
}

function Engagements() {
  const engagements = useStore((s) => s.engagements);
  const [minKills, setMinKills] = useState(3);
  const [detail, setDetail] = useState<{ id: number; kills: Kill[] } | null>(null);
  const detailFor = useRef<number | null>(null);

  const changeMin = async (n: number) => {
    setMinKills(n);
    const list = await api<Engagement[]>('GET', `/api/engagements?limit=40&minKills=${n}`).catch(() => []);
    setState((s) => ({ engagements: withEngagements(s.engagements, list) }));
  };

  const open = async (g: Engagement) => {
    detailFor.current = g.id;
    const kills = await api<Kill[]>('GET', `/api/engagements/${g.id}`).catch(() => []);
    if (detailFor.current === g.id) setDetail({ id: g.id, kills });
  };

  const rows = [...engagements.values()].filter((g) => g.kills >= minKills).sort((a, b) => b.startedAt - a.startedAt).slice(0, 15);

  return (
    <Card title="교전" extra={
      <select aria-label="최소 킬 수" value={minKills} onChange={(e) => changeMin(Number(e.target.value))}>
        {[2, 3, 5, 8].map((n) => <option key={n} value={n}>{n}킬 이상</option>)}
      </select>
    }>
      <div className="card-body">
        {detail ? (
          <div className="eng-detail">
            <div className="row-between">
              <strong>교전 #{detail.id} 상세</strong>
              <IconButton icon={faXmark} label="닫기" className="btn-ghost" onClick={() => {
                detailFor.current = null;
                setDetail(null);
              }} />
            </div>
            <div className="table-wrap"><KillTable rows={detail.kills} /></div>
          </div>
        ) : null}
        <div className="table-wrap">
          {rows.length ? <EngagementTable rows={rows} onOpen={open} /> : <Empty>조건에 맞는 교전이 없습니다.</Empty>}
        </div>
      </div>
    </Card>
  );
}

function EngagementTable({ rows, onOpen }: { rows: Engagement[]; onOpen: (g: Engagement) => void }) {
  const color = useFactionColor();
  const duration = (g: Engagement) => (g.startTime != null && g.endTime != null ? g.endTime - g.startTime : (g.endedAt - g.startedAt) / 1000);
  return (
    <SortTable rows={rows} rowKey={(g) => g.id} compact initial={{ key: 'at', dir: -1 }} columns={[
      { key: 'at', label: '시각', desc: true, sort: (g) => g.startedAt, render: (g) => (
        <>
          <div className="nowrap">{`#${g.id} · ${fmtTime(g.startedAt)}`}</div>
          <div className="muted small">{`${Math.max(1, Math.round(duration(g)))}초${g.map ? ` · ${g.map}` : ''}`}</div>
        </>
      ) },
      { key: 'kills', label: '킬', num: true, sort: (g) => g.kills, render: (g) => (g.teamkills ? <>{g.kills}<div className="danger small">{`팀킬 ${g.teamkills}`}</div></> : g.kills) },
      { key: 'people', label: '인원', num: true, sort: (g) => g.participants.length, render: (g) => g.participants.length },
      { key: 'hs', label: 'HS%', num: true, sort: (g) => pct(g.headshots, g.kills), render: (g) => `${pct(g.headshots, g.kills) ?? 0}%` },
      { key: 'factions', label: '진영', className: 'eng-bar-cell', render: (g) => {
        const factions = Object.entries(g.factions).sort((a, b) => b[1] - a[1]);
        const total = factions.reduce((s, [, n]) => s + n, 0);
        return (
          <div className="eng-bar" aria-label="진영별 킬 비중">
            {factions.map(([f, n]) => <span key={f} style={{ width: `${(n / total) * 100}%`, background: color(f) || 'var(--muted)' }} title={`${f}: ${n}킬`} />)}
          </div>
        );
      } },
      { key: 'actions', label: <span className="sr-only">작업</span>, className: 'actions', render: (g) => <button className="btn btn-sm" type="button" onClick={() => onOpen(g)}>상세</button> },
    ]} />
  );
}

function Weapons() {
  const [rows, setRows] = useState<WeaponStat[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api<WeaponStat[]>('GET', '/api/weapons?hours=24').catch(() => []).then((r) => alive && setRows(r));
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (!rows.length) return <Empty>데이터 없음</Empty>;
  return (
    <div className="table-wrap">
      <SortTable rows={rows} rowKey={(r) => r.weapon} compact initial={{ key: 'kills', dir: -1 }} columns={[
        { key: 'weapon', label: '무기', sort: (r) => r.weapon, render: (r) => r.weapon },
        { key: 'kills', label: '킬', num: true, sort: (r) => r.kills, render: (r) => r.kills },
        { key: 'hs', label: 'HS%', num: true, sort: (r) => pct(r.headshots, r.kills), render: (r) => `${pct(r.headshots, r.kills)}%` },
        { key: 'avg', label: '평균', num: true, sort: (r) => r.avgDistance, render: (r) => fmtDist(r.avgDistance) },
        { key: 'max', label: '최장', num: true, sort: (r) => r.maxDistance, render: (r) => fmtDist(r.maxDistance) },
      ]} />
    </div>
  );
}

function MatchEvents() {
  const events = useStore((s) => s.matchEvents);
  if (!events.length) return <Empty>이벤트가 없습니다.</Empty>;
  return (
    <SortTable rows={events.slice(0, 40)} rowKey={(e, i) => `${e.receivedAt}-${i}`} compact initial={{ key: 'at', dir: -1 }} columns={[
      { key: 'at', label: '시각', desc: true, sort: (e) => e.receivedAt, className: 'kill-time', render: (e) => fmtTime(e.receivedAt) },
      { key: 'type', label: '종류', sort: (e) => e.type, render: (e) => <span className="tag">{e.type}</span> },
      { key: 'detail', label: '내용', className: 'small', render: (e) => <EventDetail e={e} /> },
    ]} />
  );
}

import { useEffect, useRef, useState } from 'react';
import type { Engagement, Kill, WeaponStat } from '../lib/types.ts';
import { useStore, setState, withEngagements } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { fmtTime, fmtDist, pct, describeEvent } from '../lib/format.ts';
import { Card, Empty } from '../components/common.tsx';
import { KillRow, EngagementCard } from '../components/feedItems.tsx';

export default function Feed() {
  return (
    <div className="grid-main">
      <KillFeed />
      <div className="stack">
        <Engagements />
        <Card title="무기별 킬 (24시간)"><div className="card-body"><Weapons /></div></Card>
        <Card title="매치·입퇴장 이벤트"><div className="card-body list-tight"><MatchEvents /></div></Card>
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
    <Card title="킬피드" extra={<span className="muted small">받은 시각 기준 · 마우스를 올리면 매치 시계</span>}>
      <div className="toolbar">
        <input type="search" placeholder="이름, SteamID, 무기 검색" aria-label="킬피드 검색" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        {check('headshot', '헤드샷만')}
        {check('teamkill', '팀킬만')}
        {check('currentMatch', '이번 매치만')}
      </div>
      <div className="card-body">
        <div className="list-tight">
          {rows.length
            ? rows.slice(0, 400).map((k) => <KillRow key={k.eventId} k={k} />)
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
        <p className="muted small">직전 킬로부터 설정한 간격(기본 15초) 안에 이어진 킬을 한 교전으로 묶습니다. 위치 데이터는 게임이 주지 않으므로 서버 전체 기준입니다.</p>
        {detail ? (
          <div className="eng-detail">
            <div className="row-between">
              <strong>교전 #{detail.id} 상세</strong>
              <button className="btn btn-ghost btn-sm" onClick={() => {
                detailFor.current = null;
                setDetail(null);
              }}>닫기</button>
            </div>
            <div className="list-tight">{detail.kills.map((k) => <KillRow key={k.eventId} k={k} />)}</div>
          </div>
        ) : null}
        <div className="list-tight">
          {rows.length ? rows.map((g) => <EngagementCard key={g.id} g={g} onOpen={open} />) : <Empty>조건에 맞는 교전이 없습니다.</Empty>}
        </div>
      </div>
    </Card>
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
    <table className="table table-compact">
      <thead><tr><th>무기</th><th className="num">킬</th><th className="num">HS%</th><th className="num">평균</th><th className="num">최장</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.weapon}>
            <td>{r.weapon}</td>
            <td className="num">{r.kills}</td>
            <td className="num">{pct(r.headshots, r.kills)}%</td>
            <td className="num">{fmtDist(r.avgDistance)}</td>
            <td className="num">{fmtDist(r.maxDistance)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MatchEvents() {
  const events = useStore((s) => s.matchEvents);
  if (!events.length) return <Empty>Season 2 이벤트(매치 상태·결과·입퇴장)가 아직 없습니다.</Empty>;
  return events.slice(0, 40).map((e, i) => (
    <div key={`${e.receivedAt}-${i}`} className="evt">
      <span className="kill-time">{fmtTime(e.receivedAt)}</span>
      <span>{describeEvent(e)}</span>
    </div>
  ));
}

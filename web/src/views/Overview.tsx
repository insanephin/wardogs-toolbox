import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Live } from '../lib/types.ts';
import { useStore, can } from '../lib/store.ts';
import { run } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { Counter } from '../lib/modal.tsx';
import { fmtClock, fmtDuration, fmtAgo, fmtDist, pct, charCount, STATE_LABELS } from '../lib/format.ts';
import { Card, Empty, ScoreRow, Fdot, MapArt, useNow, useFactionColor } from '../components/common.tsx';
import { KillRow, EngagementCard } from '../components/feedItems.tsx';
import { CashCard } from '../components/cashChart.tsx';

const HS_FLAG_PCT = 60;
const HS_FLAG_MIN_KILLS = 8;
const LONG_KILL_M = 800;
const FEED_SILENT_MS = 90_000;

export default function Overview() {
  const live = useStore((s) => s.live);
  const kills = useStore((s) => s.kills);
  const engagements = useStore((s) => s.engagements);
  const now = useNow();

  const recentEng = [...engagements.values()].filter((g) => g.kills >= 3).sort((a, b) => b.startedAt - a.startedAt).slice(0, 4);

  return (
    <>
      <Banners live={live} />
      <ServerLine live={live} />
      <Stats live={live} />
      <div className="grid-2">
        <Scores live={live} />
        <Card title="이번 매치 상위 플레이어"><div className="card-body"><TopPlayers live={live} /></div></Card>
      </div>
      <CashCard />
      <div className="grid-2">
        <Card title="실시간 킬피드" extra={<a href="#feed" className="link">전체 보기</a>}>
          <div className="card-body list-tight">
            {kills.length
              ? kills.slice(0, 12).map((k) => <KillRow key={k.eventId} k={k} compact now={now} />)
              : <Empty>아직 받은 킬 이벤트가 없습니다. 연결 정보 탭에서 피드 설정을 확인하세요.</Empty>}
          </div>
        </Card>
        <Card title="최근 교전" extra={<a href="#feed" className="link">전체 보기</a>}>
          <div className="card-body">
            {recentEng.length ? recentEng.map((g) => <EngagementCard key={g.id} g={g} />) : <Empty>감지된 교전이 없습니다.</Empty>}
          </div>
        </Card>
      </div>
      <div className="grid-2">
        <Card title="이상 징후 힌트" extra={<span className="muted small">판정 아님, 확인용</span>}>
          <div className="card-body"><Hints live={live} /></div>
        </Card>
        {can('mod') ? <BroadcastCard /> : null}
      </div>
    </>
  );
}

function Banners({ live }: { live: Live | null }) {
  const items: ['info' | 'warn' | 'error', string][] = [];
  if (!live) items.push(['info', '서버 상태를 불러오는 중입니다.']);
  else {
    if (!live.online) items.push(['error', `RCON에 연결할 수 없습니다: ${live.lastError?.message ?? '알 수 없는 오류'}`]);
    if (live.mapTransition) items.push(['warn', '맵 전환 중입니다. 약 40초간 팀 정보가 비고 인원이 0으로 보일 수 있습니다. 전원 퇴장이 아닙니다.']);
    if (live.restart?.due) items.push(['warn', `가동 ${fmtDuration(live.restart.uptimeSeconds)}: 게임 자체 24시간 재시작이 이번 라운드가 끝나면 실행됩니다.`]);
    if (live.cashUnreliable) items.push(['info', '이 호스트는 모든 플레이어의 돈을 0으로 보고합니다.']);
    const f = live.feed;
    const playing = (live.status?.players?.current ?? 0) > 0;
    if (playing && !live.mapTransition && (!f?.lastBatchAt || Date.now() - f.lastBatchAt > FEED_SILENT_MS)) {
      items.push(['warn', f?.lastBatchAt
        ? `이벤트 피드가 ${fmtAgo(f.lastBatchAt)} 이후 조용합니다. 피드는 재전송이 없어 그동안의 킬은 유실됩니다.`
        : '이벤트 피드를 받은 적이 없습니다. 킬피드·교전·헤드샷률은 피드가 있어야 동작합니다.']);
    }
  }
  return (
    <div className="banners">
      {items.map(([kind, text]) => <div key={text} className={`banner banner-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{text}</div>)}
    </div>
  );
}

const MODIFIERS: Record<string, string> = { KOTH_InfantryOnly: '보병 전용', KOTH_Hardcore: '하드코어' };
function modeLabel(id: string): string {
  return MODIFIERS[id] ?? (/_KOTH_\d+$/.test(id) ? 'KOTH' : id);
}

function ServerLine({ live }: { live: Live | null }) {
  const id = live?.serverId;
  return (
    <div className="server-line small">
      <span className="muted">서버 접속 ID</span>
      {id ? (
        <button className="mono link" type="button" title="복사" onClick={() => navigator.clipboard?.writeText(id).then(() => toast('복사했습니다'))}>{id}</button>
      ) : <span className="muted">없음</span>}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

function Stats({ live }: { live: Live | null }) {
  const s = live?.status;
  const m = live?.match;
  const feedState = live?.feed?.matchState?.state;
  const modes = (s?.experiences || []).map(modeLabel).join(' · ');
  return (
    <div className="stat-grid">
      <Stat label="맵" value={s?.map ? <span className="inline-row"><MapArt map={s.map} lighting={s.lighting} variant="square" />{s.map}</span> : '—'}
        sub={s ? [modes || '모드 정보 없음', s.lighting, s.alternator && s.alternator !== 'None' ? `존 ${s.alternator}` : null].filter(Boolean).join(' · ') : null} />
      <Stat label="인원" value={s ? `${s.players.current} / ${s.players.max}` : '—'} sub={s ? '공개 슬롯 기준 (예약 슬롯 제외)' : null} />
      <Stat label="다음 맵" value={live?.nextMap ? <span className="inline-row"><MapArt map={live.nextMap.map} lighting={live.nextMap.lighting} variant="square" />{live.nextMap.map}</span> : '—'}
        sub={live?.rotationEnabled === false ? '로테이션 꺼짐: 매치가 끝나면 지금 맵을 다시 불러옵니다' : live?.nextMap ? [live.nextMap.experiences.map(modeLabel).join(' · '), live.nextMap.lighting].filter(Boolean).join(' · ') || null : null} />
      <Stat label="매치 시계" value={fmtClock(m?.matchSeconds)}
        sub={m?.matchSecondsSource === 'feed' ? '킬피드 기준 (서버가 시계를 안 보냄)' : m?.matchSecondsSource ? null : '서버·피드 모두 시계 없음'} />
      <Stat label="매치 상태" value={feedState ? STATE_LABELS[feedState] ?? feedState : '—'}
        sub={feedState ? `피드 · ${fmtAgo(live?.feed.matchState?.at)}` : 'Season 2 피드 이벤트로만 확인 가능'} />
      <Stat label="가동 시간" value={live?.restart ? fmtDuration(live.restart.uptimeSeconds) : '—'}
        sub={live?.health ? `작업 큐 ${live.health.gameThreadQueue?.depth ?? 0} · 거부 ${live.health.gameThreadQueue?.rejectedTotal ?? 0}` : null} />
    </div>
  );
}

function Scores({ live }: { live: Live | null }) {
  const m = live?.match;
  const cap = m?.scoreCap;
  const rows = live?.status?.factionScores || [];
  return (
    <Card title="진영별 점수"
      extra={cap ? <span className="muted small">{`목표 ${cap}점${m?.scoreCapAssumed ? ' (서버가 상한을 안 보내 KOTH 기본값)' : ''}`}</span> : null}>
      <div className="card-body">
        {rows.length ? rows.map((f) => <ScoreRow key={f.name} name={f.name} color={f.colorHex} score={f.score} cap={cap} />) : <Empty>점수 정보 없음</Empty>}
      </div>
    </Card>
  );
}

function TopPlayers({ live }: { live: Live | null }) {
  const color = useFactionColor();
  const stats = new Map((live?.matchStats || []).map((r) => [r.steamId, r]));
  const rows = (live?.players || [])
    .map((p) => ({ ...p, hs: stats.get(p.steamId) }))
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .slice(0, 8);
  if (!rows.length) return <Empty>접속 중인 플레이어가 없습니다.</Empty>;
  return (
    <table className="table table-compact">
      <thead><tr><th>플레이어</th><th className="num">킬</th><th className="num">데스</th><th className="num">HS%</th></tr></thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.steamId}>
            <td><Fdot color={color(p.faction)} />{p.name}</td>
            <td className="num">{p.kills}</td>
            <td className="num">{p.deaths}</td>
            <td className="num">{p.hs ? `${pct(p.hs.headshots, p.hs.kills)}%` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Hints({ live }: { live: Live | null }) {
  const names = new Map((live?.players || []).map((p) => [p.steamId, p.name]));
  const hints: { who: string; text: string }[] = [];
  for (const r of live?.matchStats || []) {
    const who = names.get(r.steamId) ?? r.steamId;
    const hsPct = pct(r.headshots, r.kills) ?? 0;
    if (r.kills >= HS_FLAG_MIN_KILLS && hsPct >= HS_FLAG_PCT) hints.push({ who, text: `헤드샷률 ${hsPct}% (${r.headshots}/${r.kills}킬)` });
    if ((r.maxDistance ?? 0) >= LONG_KILL_M) hints.push({ who, text: `최장 킬 ${fmtDist(r.maxDistance)}` });
    if (r.teamkills >= 3) hints.push({ who, text: `팀킬 추정 ${r.teamkills}회` });
  }
  return (
    <>
      {hints.length
        ? <ul className="hint-list">{hints.map((x, i) => <li key={i}><strong>{x.who}</strong> {x.text}</li>)}</ul>
        : <Empty>이번 매치에서 눈에 띄는 수치가 없습니다.</Empty>}
      <p className="muted small">{`기준: ${HS_FLAG_MIN_KILLS}킬 이상에서 헤드샷 ${HS_FLAG_PCT}% 이상, ${LONG_KILL_M}m 이상 킬, 팀킬 3회 이상. 팀킬은 폴링 진영으로 추정한 값입니다.`}</p>
    </>
  );
}

function BroadcastCard() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || charCount(text) > 256) return;
    setBusy(true);
    const r = await run('전체 공지', 'POST', '/api/broadcast', { message: text.trim() });
    setBusy(false);
    if (r) setText('');
  };
  return (
    <Card title="전체 공지" extra={<span className="muted small">게임 제한 256자</span>}>
      <form className="card-body stack" onSubmit={onSubmit}>
        <textarea rows={3} maxLength={256} placeholder="모든 플레이어에게 보낼 공지" aria-label="전체 공지 내용" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row-between">
          <Counter value={text} max={256} />
          <button className="btn btn-primary" type="submit" disabled={busy}>공지 보내기</button>
        </div>
      </form>
    </Card>
  );
}

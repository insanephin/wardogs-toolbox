// Public leaderboard at /leaderboard. No login: everything comes from /api/public/*, which only
// lists players who linked a Chzzk channel and never sends SteamIDs or Discord IDs.
import { useEffect, useState } from 'react';
import type { Leaderboard as LeaderboardData, LeaderboardRow, PublicLive } from '../lib/types.ts';
import { fmtNum, fmtDist, fmtAgo, pct, STATE_LABELS } from '../lib/format.ts';
import { Card, Empty, FactionChip, ScoreRow, useNow } from '../components/common.tsx';

type Period = 'week' | 'month' | 'all';

const PERIODS: { id: Period; label: string }[] = [
  { id: 'week', label: '이번 주' },
  { id: 'month', label: '이번 달' },
  { id: 'all', label: '전체' },
];

interface Board {
  id: string;
  label: string;
  value: (r: LeaderboardRow) => number | null;
  show: (r: LeaderboardRow) => string;
  // Ratios only rank players with enough games: `key` picks the server's minimum, `of` is what it counts.
  min?: { key: keyof LeaderboardData['minimums']; of: (r: LeaderboardRow) => number; label: (n: number) => string };
}

const BOARDS: Board[] = [
  { id: 'kills', label: '킬', value: (r) => r.kills, show: (r) => fmtNum(r.kills) },
  { id: 'kd', label: 'K/D', value: (r) => r.kd, show: (r) => r.kd.toFixed(2), min: { key: 'kd', of: (r) => r.kills, label: (n) => `${n}킬 이상` } },
  { id: 'cashEarned', label: '번 돈', value: (r) => r.cashEarned, show: (r) => fmtNum(r.cashEarned) },
  { id: 'wins', label: '승리', value: (r) => r.wins, show: (r) => fmtNum(r.wins) },
  { id: 'winRate', label: '승률', value: (r) => r.winRate, show: (r) => `${Math.round(r.winRate! * 100)}%`, min: { key: 'winRate', of: (r) => r.decided, label: (n) => `결과 난 경기 ${n}판 이상` } },
  { id: 'headshotRate', label: '헤드샷', value: (r) => r.headshotRate, show: (r) => `${Math.round(r.headshotRate! * 100)}%`, min: { key: 'headshotRate', of: (r) => r.feedKills, label: (n) => `${n}킬 이상` } },
  { id: 'longest', label: '최장거리', value: (r) => r.longest, show: (r) => fmtDist(r.longest) },
];

const NOTES: Record<string, string> = {
  cashEarned: '번 돈은 서버를 주기적으로 조회해 잔액이 늘어난 만큼 더한 추정치입니다. 조회 사이에 벌고 바로 쓴 돈은 빠지므로 실제보다 적게 잡힙니다.',
  wins: '경기가 끝났을 때 속해 있던 진영 기준입니다.',
  winRate: '경기가 끝났을 때 속해 있던 진영 기준입니다.',
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'omit' });
  if (!res.ok) throw new Error(`요청 실패 (${res.status})`);
  return res.json();
}

// Fetches now and then every `ms`, keeping the last good answer through a failed refresh.
function usePolled<T>(path: string, ms: number) {
  const [state, setState] = useState<{ data: T | null; error: Error | null }>({ data: null, error: null });
  useEffect(() => {
    let alive = true;
    const load = () => getJson<T>(path).then(
      (data) => alive && setState({ data, error: null }),
      (error) => alive && setState((s) => ({ data: s.data, error })),
    );
    load();
    const t = setInterval(load, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path, ms]);
  return state;
}

export default function Leaderboard() {
  const [period, setPeriod] = useState<Period>('week');
  const [board, setBoard] = useState('kills');

  useEffect(() => {
    document.title = 'WARDOGS 리더보드';
  }, []);

  return (
    <div className="lb">
      <header className="lb-head">
        <div className="brand"><span>WARDOGS 리더보드</span></div>
        <p className="muted small">치지직 채널을 연동한 플레이어만 순위에 오릅니다. 연동은 디스코드에서 할 수 있어요.</p>
      </header>
      <LiveMatch />
      <Rankings period={period} setPeriod={setPeriod} board={board} setBoard={setBoard} />
    </div>
  );
}

function LiveMatch() {
  const { data: live } = usePolled<PublicLive>('/api/public/live', 10_000);
  useNow();
  if (!live) return null;
  const cap = live.scoreCap;
  const players = [...live.players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  const color = (name: string | null) => live.factionScores.find((f) => f.name === name)?.colorHex;

  return (
    <Card title="지금 경기" extra={
      <span className="muted small">
        {live.online
          ? [live.map, live.matchState && STATE_LABELS[live.matchState], live.maxPlayers ? `${live.playerCount} / ${live.maxPlayers}명` : null].filter(Boolean).join(' · ')
          : '서버 오프라인'}
      </span>
    }>
      {live.online ? (
        <div className="card-body">
          {live.factionScores.map((f) => <ScoreRow key={f.name} name={f.name} color={f.colorHex} score={f.score} cap={cap} />)}
          {players.length ? (
            <div className="table-wrap lb-live">
              <table className="table table-compact">
                <thead>
                  <tr><th>치지직</th><th>진영</th><th className="num">킬</th><th className="num">데스</th><th className="num">돈</th></tr>
                </thead>
                <tbody>
                  {players.map((p) => (
                    <tr key={p.channelId}>
                      <td><ChannelLink p={p} /></td>
                      <td><FactionChip name={p.faction} color={color(p.faction)} /></td>
                      <td className="num">{p.kills}</td>
                      <td className="num">{p.deaths}</td>
                      <td className="num">{fmtNum(p.cash)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Empty>지금 접속한 연동 플레이어가 없습니다.</Empty>}
          <p className="muted small lb-updated">{`갱신 ${fmtAgo(live.updatedAt)}`}</p>
        </div>
      ) : null}
    </Card>
  );
}

function Rankings({ period, setPeriod, board, setBoard }: { period: Period; setPeriod: (p: Period) => void; board: string; setBoard: (b: string) => void }) {
  const { data, error } = usePolled<LeaderboardData>(`/api/public/leaderboard?period=${period}`, 60_000);
  const def = BOARDS.find((b) => b.id === board) ?? BOARDS[0]!;
  const min = def.min ? data?.minimums?.[def.min.key] ?? null : null;
  const minText = def.min && min != null ? def.min.label(min) : null;
  const rows = (data?.rows || [])
    .filter((r) => (def.value(r) ?? 0) > 0 && (min == null || def.min!.of(r) >= min))
    .sort((a, b) => def.value(b)! - def.value(a)! || b.kills - a.kills)
    .slice(0, 100);

  return (
    <Card title="순위" extra={
      <div className="seg" role="group" aria-label="기간">
        {PERIODS.map((p) => (
          <button key={p.id} type="button" className={period === p.id ? 'on' : ''} aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>{p.label}</button>
        ))}
      </div>
    }>
      <div className="toolbar">
        <div className="seg" role="group" aria-label="순위 기준">
          {BOARDS.map((b) => (
            <button key={b.id} type="button" className={board === b.id ? 'on' : ''} aria-pressed={board === b.id} onClick={() => setBoard(b.id)}>{b.label}</button>
          ))}
        </div>
      </div>
      <div className="card-body">
        {!data ? (
          <Empty>{error ? `불러오지 못했습니다: ${error.message}` : '불러오는 중…'}</Empty>
        ) : !rows.length ? (
          <Empty>{minText ? `아직 기준(${minText})을 채운 플레이어가 없습니다.` : '아직 기록이 없습니다.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table lb-table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>치지직</th>
                  <th className="num lb-key">{def.label}</th>
                  <th className="num">경기</th>
                  <th className="num">킬</th>
                  <th className="num">데스</th>
                  <th className="num">K/D</th>
                  <th className="num">승리</th>
                  <th className="num">HS%</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.channelId} className={i < 3 ? `lb-top lb-top-${i + 1}` : undefined}>
                    <td className="num lb-rank">{i + 1}</td>
                    <td><ChannelLink p={r} /></td>
                    <td className="num lb-key">{def.show(r)}</td>
                    <td className="num">{fmtNum(r.matches)}</td>
                    <td className="num">{fmtNum(r.kills)}</td>
                    <td className="num">{fmtNum(r.deaths)}</td>
                    <td className="num">{r.kd.toFixed(2)}</td>
                    <td className="num">{fmtNum(r.wins)}</td>
                    <td className="num">{r.feedKills ? `${pct(r.headshots, r.feedKills)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="card-foot muted small">
        {[minText ? `${def.label} 순위는 ${minText}인 플레이어만 집계합니다.` : null, NOTES[board],
          '킬·데스·돈은 게임 스코어보드, 헤드샷·최장거리는 킬 피드 기준입니다. 주간은 월요일 0시, 월간은 1일 0시(한국 시간)에 초기화됩니다.']
          .filter(Boolean).join(' ')}
      </p>
    </Card>
  );
}

function ChannelLink({ p }: { p: { channelId: string; name: string | null } }) {
  return (
    <a className="pname lb-name" href={`https://chzzk.naver.com/${encodeURIComponent(p.channelId)}`} target="_blank" rel="noopener noreferrer">
      {p.name || '치지직 채널'}
    </a>
  );
}

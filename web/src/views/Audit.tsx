import { useCallback, useEffect, useState } from 'react';
import type { Action, ActionDetail, Audit as AuditData, FeedEvent, FeedRequestRow } from '../lib/types.ts';
import { api, errorMessage } from '../lib/api.ts';
import { fmtTime, ACTION_LABELS, describeEvent } from '../lib/format.ts';
import { Card, Empty, useOnAction } from '../components/common.tsx';

const TABS = [['dashboard', '대시보드 작업'], ['rcon', 'RCON 접속 로그'], ['feedRequests', '피드 수신 기록'], ['feedEvents', '피드 이벤트']];

const FEED_ERRORS: Record<string, string> = { bad_token: '토큰 불일치', bad_json: 'JSON 오류', bad_batch: '형식 오류', body_too_large: '본문 초과' };

export default function Audit() {
  const [tab, setTab] = useState('dashboard');
  const [data, setData] = useState<AuditData | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<AuditData>('GET', '/api/audit'));
    } catch (err) {
      setData({ dashboard: [], rcon: [], rconError: errorMessage(err), feedRequests: [], feedEvents: [] });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useOnAction(load);

  return (
    <Card title="감사 로그" extra={<button className="btn btn-sm" type="button" onClick={load}>새로고침</button>}>
      <div className="toolbar">
        <div className="seg" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="card-body">
        {!data ? <Empty>불러오는 중…</Empty>
          : tab === 'dashboard' ? <DashboardLog rows={data.dashboard} />
            : tab === 'rcon' ? <RconLog data={data} />
              : tab === 'feedRequests' ? <FeedRequestLog rows={data.feedRequests} />
                : <FeedEventLog rows={data.feedEvents} />}
      </div>
    </Card>
  );
}

function DashboardLog({ rows }: { rows: Action[] }) {
  return (
    <>
      <p className="muted small">RCON 토큰은 하나라 게임 서버 로그로는 누가 했는지 알 수 없습니다. 이 기록이 관리자별 작업 이력입니다.</p>
      {rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>시각</th><th>관리자</th><th>작업</th><th>대상</th><th>내용</th><th>결과</th></tr></thead>
            <tbody>
              {rows.map((a, i) => (
                <tr key={a.id ?? i}>
                  <td className="nowrap">{fmtTime(a.at)}</td>
                  <td>{a.actor}</td>
                  <td>{ACTION_LABELS[a.action] ?? a.action}</td>
                  <td className="mono small">{a.target || '—'}</td>
                  <td className="small">{describe(a.detail)}</td>
                  <td>{a.ok ? <span className="tag tag-hs">성공</span> : <span className="tag tag-danger" title={a.error ?? undefined}>실패</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>기록이 없습니다.</Empty>}
    </>
  );
}

function RconLog({ data }: { data: AuditData }) {
  return (
    <>
      {data.rconError ? <div className="banner banner-error">{data.rconError}</div> : null}
      <p className="muted small">게임 서버 RCON 리스너의 접속 기록입니다. 게임 이벤트가 아닙니다. 프록시 뒤에 있으면 모든 접속이 127.0.0.1로 보입니다.</p>
      {data.rcon?.length ? (
        <div className="table-wrap">
          <table className="table table-compact">
            <thead><tr><th>시각</th><th>이벤트</th><th>접속지</th><th>내용</th></tr></thead>
            <tbody>
              {data.rcon.map((e, i) => (
                <tr key={i}>
                  <td className="nowrap">{fmtTime(Date.parse(e.timestampUtc))}</td>
                  <td><span className={`tag${e.event === 'AUTH_FAIL' || e.event === 'REJECT' ? ' tag-danger' : ''}`}>{e.event}</span></td>
                  <td className="mono small">{e.peer}</td>
                  <td className="mono small">{e.detail || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>기록이 없습니다.</Empty>}
    </>
  );
}

function FeedRequestLog({ rows }: { rows: FeedRequestRow[] }) {
  return (
    <>
      <p className="muted small">게임 서버가 이벤트 피드로 보낸 요청입니다. 거부된 요청(토큰 불일치 등)도 남습니다. 최근 5000건만 보관하며, 프록시 뒤에 있으면 접속지가 프록시 주소로 보입니다.</p>
      {rows?.length ? (
        <div className="table-wrap">
          <table className="table table-compact">
            <thead><tr><th>시각</th><th>결과</th><th>접속지</th><th className="num">이벤트</th><th className="num">신규</th><th className="num">중복</th><th>오류</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">{fmtTime(r.at)}</td>
                  <td>{r.status === 200 ? <span className="tag tag-hs">수신</span> : <span className="tag tag-danger">{(r.code && FEED_ERRORS[r.code]) ?? `거부 ${r.status}`}</span>}</td>
                  <td className="mono small">{r.peer || '—'}</td>
                  <td className="num">{r.events ?? '—'}</td>
                  <td className="num">{r.accepted ?? '—'}</td>
                  <td className="num">{r.duplicates ?? '—'}</td>
                  <td className="small">{r.error || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>기록이 없습니다.</Empty>}
    </>
  );
}

function FeedEventLog({ rows }: { rows: FeedEvent[] }) {
  return (
    <>
      <p className="muted small">이벤트 피드로 받은 킬·매치 상태·결과·입퇴장을 받은 순서대로 보여줍니다. 최근 300건입니다.</p>
      {rows?.length ? (
        <div className="table-wrap">
          <table className="table table-compact">
            <thead><tr><th>시각</th><th>종류</th><th>내용</th><th>맵</th></tr></thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={e.eventId ?? i}>
                  <td className="nowrap">{fmtTime(e.receivedAt)}</td>
                  <td><span className={`tag${e.teamkill ? ' tag-danger' : ''}`}>{e.type}</span></td>
                  <td className="small">{describeEvent(e)}</td>
                  <td className="small">{e.map ?? e.mapName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>기록이 없습니다.</Empty>}
    </>
  );
}

function describe(d: ActionDetail | null): string {
  if (!d) return '—';
  const parts: string[] = [];
  if (d.name) parts.push(d.name);
  if (d.reason) parts.push(`사유: ${d.reason}`);
  if (d.message) parts.push(`"${d.message}"`);
  if (d.faction) parts.push(`→ ${d.faction}`);
  if (d.map) parts.push(d.map);
  if (d.via === 'config') parts.push('설정 문서 경유');
  if (d.queuedBy) parts.push(`등록: ${d.queuedBy}`);
  return parts.join(' · ') || '—';
}

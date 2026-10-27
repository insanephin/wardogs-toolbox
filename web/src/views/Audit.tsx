import { useCallback, useEffect, useState } from 'react';
import type { Action, ActionDetail, Audit as AuditData, FeedEvent, FeedRequestRow } from '../lib/types.ts';
import { api, errorMessage } from '../lib/api.ts';
import type { ReactNode } from 'react';
import { fmtTime, ACTION_LABELS } from '../lib/format.ts';
import { EventDetail } from '../components/feedItems.tsx';
import { Icon } from '../components/iconButton.tsx';
import { Card, PageActions, Empty, useOnAction } from '../components/common.tsx';
import { Spinner } from '../components/spinner.tsx';
import { SortTable } from '../components/sortTable.tsx';
import { IconButton } from '../components/iconButton.tsx';
import { faRotateRight, faArrowRight } from '@fortawesome/free-solid-svg-icons';

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
    <Card>
      <PageActions><IconButton icon={faRotateRight} label="새로고침" onClick={load} /></PageActions>
      <div className="toolbar">
        <div className="seg" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="card-body">
        {!data ? <Empty><Spinner /></Empty>
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
      {rows.length ? (
        <div className="table-wrap">
          <SortTable rows={rows} rowKey={(a, i) => a.id ?? i} initial={{ key: 'at', dir: -1 }} columns={[
            { key: 'at', label: '시각', desc: true, sort: (a) => a.at, className: 'nowrap', render: (a) => fmtTime(a.at) },
            { key: 'actor', label: '관리자', sort: (a) => a.actor, render: (a) => a.actor },
            { key: 'action', label: '작업', sort: (a) => ACTION_LABELS[a.action] ?? a.action, render: (a) => ACTION_LABELS[a.action] ?? a.action },
            { key: 'target', label: '대상', sort: (a) => a.target, className: 'mono small', render: (a) => a.target || '—' },
            { key: 'detail', label: '내용', className: 'small', render: (a) => describe(a.detail) },
            { key: 'ok', label: '결과', sort: (a) => a.ok, render: (a) => (a.ok ? <span className="tag tag-hs">성공</span> : <span className="tag tag-danger" title={a.error ?? undefined}>실패</span>) },
          ]} />
        </div>
      ) : <Empty>기록이 없습니다.</Empty>}
    </>
  );
}

function RconLog({ data }: { data: AuditData }) {
  return (
    <>
      {data.rconError ? <div className="banner banner-error">{data.rconError}</div> : null}
      {data.rcon?.length ? (
        <div className="table-wrap">
          <SortTable rows={data.rcon} rowKey={(_, i) => i} compact initial={{ key: 'at', dir: -1 }} columns={[
            { key: 'at', label: '시각', desc: true, sort: (e) => Date.parse(e.timestampUtc), className: 'nowrap', render: (e) => fmtTime(Date.parse(e.timestampUtc)) },
            { key: 'event', label: '이벤트', sort: (e) => e.event, render: (e) => <span className={`tag${e.event === 'AUTH_FAIL' || e.event === 'REJECT' ? ' tag-danger' : ''}`}>{e.event}</span> },
            { key: 'peer', label: '접속지', sort: (e) => e.peer, className: 'mono small', render: (e) => e.peer },
            { key: 'detail', label: '내용', sort: (e) => e.detail, className: 'mono small', render: (e) => e.detail || '—' },
          ]} />
        </div>
      ) : <Empty>기록이 없습니다.</Empty>}
    </>
  );
}

function FeedRequestLog({ rows }: { rows: FeedRequestRow[] }) {
  return (
    <>
      {rows?.length ? (
        <div className="table-wrap">
          <SortTable rows={rows} rowKey={(r) => r.id} compact initial={{ key: 'at', dir: -1 }} columns={[
            { key: 'at', label: '시각', desc: true, sort: (r) => r.at, className: 'nowrap', render: (r) => fmtTime(r.at) },
            { key: 'status', label: '결과', sort: (r) => r.status, render: (r) => (r.status === 200 ? <span className="tag tag-hs">수신</span> : <span className="tag tag-danger">{(r.code && FEED_ERRORS[r.code]) ?? `거부 ${r.status}`}</span>) },
            { key: 'peer', label: '접속지', sort: (r) => r.peer, className: 'mono small', render: (r) => r.peer || '—' },
            { key: 'events', label: '이벤트', num: true, sort: (r) => r.events, render: (r) => r.events ?? '—' },
            { key: 'accepted', label: '신규', num: true, sort: (r) => r.accepted, render: (r) => r.accepted ?? '—' },
            { key: 'duplicates', label: '중복', num: true, sort: (r) => r.duplicates, render: (r) => r.duplicates ?? '—' },
            { key: 'error', label: '오류', sort: (r) => r.error, className: 'small', render: (r) => r.error || '—' },
          ]} />
        </div>
      ) : <Empty>기록이 없습니다.</Empty>}
    </>
  );
}

function FeedEventLog({ rows }: { rows: FeedEvent[] }) {
  return (
    <>
      {rows?.length ? (
        <div className="table-wrap">
          <SortTable rows={rows} rowKey={(e, i) => e.eventId ?? i} compact initial={{ key: 'at', dir: -1 }} columns={[
            { key: 'at', label: '시각', desc: true, sort: (e) => e.receivedAt, className: 'nowrap', render: (e) => fmtTime(e.receivedAt) },
            { key: 'type', label: '종류', sort: (e) => e.type, render: (e) => <span className={`tag${e.teamkill ? ' tag-danger' : ''}`}>{e.type}</span> },
            { key: 'detail', label: '내용', className: 'small', render: (e) => <EventDetail e={e} /> },
            { key: 'map', label: '맵', sort: (e) => e.map ?? e.mapName, className: 'small', render: (e) => e.map ?? e.mapName ?? '—' },
          ]} />
        </div>
      ) : <Empty>기록이 없습니다.</Empty>}
    </>
  );
}

function describe(d: ActionDetail | null): ReactNode {
  if (!d) return '—';
  const parts: ReactNode[] = [];
  if (d.name) parts.push(d.name);
  if (d.reason) parts.push(`사유: ${d.reason}`);
  if (d.message) parts.push(`"${d.message}"`);
  if (d.faction) parts.push(<><Icon icon={faArrowRight} className="inline-icon" aria-label="이동" /> {d.faction}</>);
  if (d.map) parts.push(d.map);
  if (d.via === 'config') parts.push('설정 문서 경유');
  if (d.queuedBy) parts.push(`등록: ${d.queuedBy}`);
  return parts.length ? parts.map((p, i) => <span key={i}>{i ? ' · ' : null}{p}</span>) : '—';
}

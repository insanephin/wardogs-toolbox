import { useCallback, useEffect, useRef, useState } from 'react';
import type { Report } from '../lib/types.ts';
import { can, useStore } from '../lib/store.ts';
import { api, run, errorMessage } from '../lib/api.ts';
import { modal } from '../lib/modal.tsx';
import { fmtDateTime } from '../lib/format.ts';
import { Card, PageActions, Empty, useOnAction } from '../components/common.tsx';
import { Spinner } from '../components/spinner.tsx';
import { SortTable } from '../components/sortTable.tsx';
import { IconButton } from '../components/iconButton.tsx';
import { faRotateRight } from '@fortawesome/free-solid-svg-icons';

const STATUS_LABEL: Record<string, string> = { open: '접수', resolved: '처리 완료', rejected: '반려' };
const FILTERS = [['all', '전체'], ...Object.entries(STATUS_LABEL)];

interface Data {
  categories: Record<string, string>;
  reports: Report[];
}

export default function Reports() {
  const [filter, setFilter] = useState<string>('open');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api<Data>('GET', `/api/reports${filter === 'all' ? '' : `?status=${filter}`}`));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [filter]);
  useEffect(() => {
    load();
  }, [load]);
  useOnAction((a) => a.action === 'report_update' && load());

  const lastReport = useStore((s) => s.lastReport);
  const seen = useRef(lastReport);
  useEffect(() => {
    if (lastReport && lastReport !== seen.current) {
      seen.current = lastReport;
      load();
    }
  }, [lastReport, load]);

  const handle = async (r: Report) => {
    const v = await modal({
      title: `신고 #${r.id} 처리`,
      fields: [
        { name: 'status', label: '상태', type: 'select', value: r.status === 'open' ? 'resolved' : r.status,
          options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })) },
        { name: 'note', label: '메모 (관리자만 봄)', type: 'textarea', value: r.note ?? '', max: 500, rows: 3 },
      ],
      confirm: '저장',
      danger: false,
    });
    if (v && await run('신고 처리', 'POST', `/api/reports/${r.id}`, v)) load();
  };

  const cat = (id: string) => data?.categories[id] ?? id;

  return (
    <Card>
      <PageActions><IconButton icon={faRotateRight} label="새로고침" onClick={load} /></PageActions>
      <div className="toolbar">
        <div className="seg" role="tablist">
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
      </div>
      <div className="card-body">
        {error ? <div className="banner banner-error">{error}</div> : null}
        {!data ? <Empty><Spinner /></Empty> : !data.reports.length ? <Empty>신고가 없습니다.</Empty> : (
          <div className="table-wrap">
            <SortTable rows={data.reports} rowKey={(r) => r.id} initial={{ key: 'createdAt', dir: -1 }} columns={[
              { key: 'createdAt', label: '시각', desc: true, sort: (r) => r.createdAt, className: 'nowrap', render: (r) => (
                <>{fmtDateTime(r.createdAt)}{r.map ? <div className="muted small">{r.map}</div> : null}</>
              ) },
              { key: 'target', label: '대상', sort: (r) => r.targetName, className: 'nowrap', render: (r) => (
                <>
                  {r.targetName}
                  <div className="mono small muted">{r.targetSteamId ?? 'SteamID 모름'}</div>
                </>
              ) },
              { key: 'category', label: '유형', sort: (r) => cat(r.category), className: 'nowrap', render: (r) => cat(r.category) },
              { key: 'description', label: '내용', className: 'small report-content', render: (r) => (
                <>
                  <div className="report-desc">{r.description}</div>
                  {r.evidenceUrl ? <a className="link" href={r.evidenceUrl} target="_blank" rel="noopener noreferrer">증거 링크</a> : null}
                </>
              ) },
              { key: 'reporter', label: '신고자', sort: (r) => r.reporterChzzkName ?? r.reporterSteamName ?? r.reporterSteamId, className: 'small nowrap', render: (r) => (
                <>
                  {r.reporterChzzkName ? <div>{`${r.reporterChzzkName} (치지직)`}</div> : null}
                  {r.reporterSteamName ? <div>{`${r.reporterSteamName} (스팀)`}</div> : null}
                  {r.reporterSteamId ? <div className="mono muted">{r.reporterSteamId}</div> : null}
                </>
              ) },
              { key: 'status', label: '상태', sort: (r) => STATUS_LABEL[r.status] ?? r.status, className: 'small nowrap', render: (r) => (
                <>
                  <span className={r.status === 'open' ? 'tag tag-danger' : 'tag'}>{STATUS_LABEL[r.status] ?? r.status}</span>
                  {r.handledBy ? <div className="muted">{`${r.handledBy} · ${fmtDateTime(r.handledAt)}`}</div> : null}
                  {r.note ? <div className="report-desc muted">{r.note}</div> : null}
                </>
              ) },
              ...(can('mod') ? [{ key: 'actions', label: <span className="sr-only">작업</span>, className: 'actions', render: (r: Report) => (
                <button className="btn btn-sm" type="button" onClick={() => handle(r)}>처리</button>
              ) }] : []),
            ]} />
          </div>
        )}
      </div>
    </Card>
  );
}

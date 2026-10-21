import { useCallback, useEffect, useRef, useState } from 'react';
import type { Report } from '../lib/types.ts';
import { can, useStore } from '../lib/store.ts';
import { api, run, errorMessage } from '../lib/api.ts';
import { modal } from '../lib/modal.tsx';
import { fmtTime } from '../lib/format.ts';
import { Card, Empty, useOnAction } from '../components/common.tsx';
import { Spinner } from '../components/spinner.tsx';

const STATUS_LABEL: Record<string, string> = { open: '접수', resolved: '처리 완료', rejected: '반려' };
const FILTERS = [...Object.entries(STATUS_LABEL), ['all', '전체']];

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
    <Card title="신고" extra={<button className="btn btn-sm" type="button" onClick={load}>새로고침</button>}>
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
            <table className="table">
              <thead><tr><th>시각</th><th>대상</th><th>유형</th><th>내용</th><th>신고자</th><th>상태</th>{can('mod') ? <th /> : null}</tr></thead>
              <tbody>
                {data.reports.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{fmtTime(r.createdAt)}{r.map ? <div className="muted small">{r.map}</div> : null}</td>
                    <td>
                      {r.targetName}
                      <div className="mono small muted">{r.targetSteamId ?? 'SteamID 모름'}</div>
                    </td>
                    <td className="nowrap">{cat(r.category)}</td>
                    <td className="small">
                      <div className="report-desc">{r.description}</div>
                      {r.evidenceUrl ? <a className="link" href={r.evidenceUrl} target="_blank" rel="noopener noreferrer">증거 링크</a> : null}
                    </td>
                    <td className="small">
                      {r.reporterChzzkName ? <div>{`${r.reporterChzzkName} (치지직)`}</div> : null}
                      {r.reporterSteamName ? <div>{`${r.reporterSteamName} (스팀)`}</div> : null}
                      {r.reporterSteamId ? <div className="mono muted">{r.reporterSteamId}</div> : null}
                    </td>
                    <td className="small">
                      <span className={r.status === 'open' ? 'tag tag-danger' : 'tag'}>{STATUS_LABEL[r.status] ?? r.status}</span>
                      {r.handledBy ? <div className="muted">{`${r.handledBy} · ${fmtTime(r.handledAt)}`}</div> : null}
                      {r.note ? <div className="report-desc muted">{r.note}</div> : null}
                    </td>
                    {can('mod') ? <td><button className="btn btn-sm" type="button" onClick={() => handle(r)}>처리</button></td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

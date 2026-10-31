import { useCallback, useEffect, useRef, useState } from 'react';
import type { Report } from '../lib/types.ts';
import { can, useStore } from '../lib/store.ts';
import { api, run, errorMessage, scoped } from '../lib/api.ts';
import { modal, openDialog, Overlay } from '../lib/modal.tsx';
import { fmtDateTime } from '../lib/format.ts';
import { Card, PageActions, Empty, useOnAction } from '../components/common.tsx';
import { Spinner } from '../components/spinner.tsx';
import { SortTable } from '../components/sortTable.tsx';
import { IconButton } from '../components/iconButton.tsx';
import { faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { openPlayerById } from '../components/playerDialog.tsx';
import { PlayerName } from '../components/playerName.tsx';

function showImage(reportId: number, images: number[], start: number) {
  openDialog((close) => <ImageViewer reportId={reportId} images={images} start={start} close={close} />);
}

function ImageViewer({ reportId, images, start, close }: { reportId: number; images: number[]; start: number; close: () => void }) {
  const [i, setI] = useState(start);
  const src = scoped(`/api/reports/${reportId}/images/${images[i]}`);
  return (
    <Overlay label="첨부 이미지" wide onClose={close}>
      <div className="row-between">
        <h2>{`신고 #${reportId} 첨부 이미지 ${i + 1}/${images.length}`}</h2>
        <button className="btn btn-ghost" type="button" onClick={close}>닫기</button>
      </div>
      <img className="img-full" src={src} alt={`첨부 이미지 ${i + 1}`} />
      {images.length > 1 ? (
        <div className="row-wrap">
          <button className="btn btn-sm" type="button" disabled={i === 0} onClick={() => setI(i - 1)}>이전</button>
          <button className="btn btn-sm" type="button" disabled={i === images.length - 1} onClick={() => setI(i + 1)}>다음</button>
          <a className="btn btn-sm toolbar-end" href={src} target="_blank" rel="noopener noreferrer">원본 열기</a>
        </div>
      ) : <div className="row-wrap"><a className="btn btn-sm toolbar-end" href={src} target="_blank" rel="noopener noreferrer">원본 열기</a></div>}
    </Overlay>
  );
}

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
                  <PlayerName steamId={r.targetSteamId} name={r.targetName} />
                  <div className="mono small muted">{r.targetSteamId ?? 'SteamID 모름'}</div>
                </>
              ) },
              { key: 'category', label: '유형', sort: (r) => cat(r.category), className: 'nowrap', render: (r) => cat(r.category) },
              { key: 'description', label: '내용', className: 'small report-content', render: (r) => (
                <>
                  <div className="report-desc">{r.description}</div>
                  {r.evidenceUrl ? <a className="link" href={r.evidenceUrl} target="_blank" rel="noopener noreferrer">증거 링크</a> : null}
                  {r.images?.length ? (
                    <div className="thumbs">
                      {r.images.map((img, i) => (
                        <button key={img} type="button" className="thumb-btn" aria-label={`첨부 이미지 ${i + 1} 크게 보기`} onClick={() => showImage(r.id, r.images, i)}>
                          <img className="thumb" src={scoped(`/api/reports/${r.id}/images/${img}`)} alt="" loading="lazy" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              ) },
              { key: 'reporter', label: '신고자', sort: (r) => r.reporterSteamName ?? r.reporterSteamId ?? r.reporterDiscordName, className: 'small nowrap', render: (r) => (r.reporterSteamId || r.reporterDiscordId ? (
                <>
                  {r.reporterSteamId ? (
                    <button type="button" className="tag tag-steam" title={`${r.reporterSteamId} · 플레이어 관리 열기`}
                      onClick={() => openPlayerById(r.reporterSteamId!, {
                        name: r.reporterSteamName,
                        link: r.reporterChzzkId ? { steamId: r.reporterSteamId!, steamName: r.reporterSteamName, chzzkChannelId: r.reporterChzzkId, chzzkName: r.reporterChzzkName, linkedAt: null } : null,
                      })}>{r.reporterSteamName || r.reporterSteamId}</button>
                  ) : null}
                  {r.reporterDiscordId ? (
                    <div><PlayerName className="tag tag-discord" steamId={r.reporterSteamId} name={r.reporterSteamName}>{r.reporterDiscordName || r.reporterDiscordId}</PlayerName></div>
                  ) : null}
                </>
              ) : <span className="muted">—</span>) },
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

import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useStore, can } from '../lib/store.ts';
import { api, run, errorMessage } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { fmtAgo, fmtNum } from '../lib/format.ts';
import { Card, Empty, useNow } from '../components/common.tsx';
import type { ReactNode } from 'react';
import type { Capabilities, FeedEndpoint, Live } from '../lib/types.ts';
import { IconButton } from '../components/iconButton.tsx';
import { faCopy } from '@fortawesome/free-solid-svg-icons';

type KvRow = [label: string, value: ReactNode, cls?: string];

function gameFeedLabel(g: Live['gameFeed'] | undefined, caps: Capabilities | null): string {
  if (caps && !caps.features?.feed) return '이 빌드는 알려 주지 않음';
  if (!g) return '—';
  if (!g.enabled) return '꺼짐 (bEventFeedEnabled)';
  return g.anyUnhealthy ? `실패 보고됨 · 엔드포인트 ${g.endpointCount}개` : `정상 · 엔드포인트 ${g.endpointCount}개`;
}

export default function Server() {
  const caps = useStore((s) => s.caps);
  const live = useStore((s) => s.live);
  useNow();
  const f = live?.feed;
  const snippet = [
    '[/Script/WDRCON.WDRCONSettings]',
    'bEventFeedEnabled=True',
    '!EventFeedEndpoints=ClearArray',
    `.EventFeedEndpoints=(Url="${location.origin}/api/ingest/events",Token="<FEED_TOKEN 값>")`,
    `EventFeedServerName=${live?.status?.serverName ?? '<서버 이름>'}`,
  ].join('\n');

  const kv = (rows: KvRow[]) => (
    <dl className="kv card-body">
      {rows.map(([k, v, cls]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`} className={cls}>{v}</dd>])}
    </dl>
  );

  return (
    <div className="stack">
      <div className="grid-2">
        <Card title="RCON 연결">
          {kv([
            ['상태', live?.online ? '연결됨' : `끊김 ${live?.lastError ? `(${live.lastError.message})` : ''}`],
            ['폴링 주기', live ? `${live.intervalMs / 1000}초 (보는 사람이 있으면 짧게, 빈 서버는 30초)` : '—'],
            ['마지막 폴링', fmtAgo(live?.lastPollAt)],
            ['게임 빌드', caps?.build ?? '—', 'mono'],
            ...(caps?.version?.project?.version ? [['게임 버전', `${caps.version.project.name ?? ''} ${caps.version.project.version}`.trim()] as KvRow] : []),
            ['API 버전', caps?.apiVersion ?? '—'],
            ['요청 한도', caps?.limits ? `분당 ${fmtNum(caps.limits.maxRequestsPerMinutePerIp)}회 · 본문 ${fmtNum(caps.limits.maxBodyBytes)}바이트` : '—'],
            ['설정 쓰기', caps?.config ? (caps.config.writable ? '가능' : '불가') : '—'],
            ['접속 코드', live?.serverId || '없음 (호스트가 지정 안 함)', 'mono'],
          ])}
        </Card>
        <Card title="이벤트 피드 수신">
          {kv([
            ['마지막 배치', f?.lastBatchAt ? fmtAgo(f.lastBatchAt) : '받은 적 없음'],
            ['받은 배치', `${fmtNum(f?.batches ?? 0)} (이번 실행 기준)`],
            ['거부된 요청', `${fmtNum(f?.rejected ?? 0)}${f?.rejected ? ' · 토큰 불일치 확인' : ''}`],
            ['피드 서버 이름', f?.serverName ?? '—'],
            ['현재 매치 키', f?.matchKey ?? '—', 'mono small'],
            ['게임 서버 쪽 전송', gameFeedLabel(live?.gameFeed, caps), live?.gameFeed?.anyUnhealthy ? 'danger' : ''],
          ])}
        </Card>
      </div>
      {can('admin') && live?.gameFeed?.endpoints?.length ? <EndpointsCard endpoints={live.gameFeed.endpoints} /> : null}
      <SponsorCard />
      {can('admin') ? (
        <Card title="피드 연결" extra={<IconButton icon={faCopy} label="복사" onClick={() => navigator.clipboard?.writeText(snippet).then(() => toast('복사했습니다'))} />}>
          <div className="card-body stack">
            <p className="muted small">ServerSettings.ini에 넣고 재시작. Url은 게임 서버에서 닿는 주소로.</p>
            <pre className="code">{snippet}</pre>
          </div>
        </Card>
      ) : null}
      <Card title="이 서버가 제공하는 경로" extra={<span className="muted small">{caps ? `${caps.routes.length}개` : ''}</span>}>
        <div className="card-body">
          {caps ? <ul className="route-list mono small">{caps.routes.map((r) => <li key={r}>{r}</li>)}</ul> : <Empty>아직 불러오지 못했습니다.</Empty>}
        </div>
      </Card>
    </div>
  );
}

function SponsorCard() {
  const caps = useStore((s) => s.caps);
  const admin = can('admin');
  const editable = admin && (caps?.features?.configDocument ?? true);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [broken, setBroken] = useState(false);

  const load = () => api<{ url: string }>('GET', '/api/sponsor').then((d) => {
    setUrl(d.url);
    setDraft(d.url);
    setBroken(false);
  }, (err) => setError(errorMessage(err)));
  useEffect(() => {
    load();
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run('스폰서 이미지', 'PUT', '/api/sponsor', { url: draft.trim() })) load();
  };

  return (
    <Card title="스폰서 이미지">
      <div className="card-body stack">
        {error ? <Empty>불러오지 못했습니다: {error}</Empty> : url == null ? null : url ? (
          broken ? <p className="danger small">주소는 설정되어 있지만 이미지를 불러오지 못했습니다.</p>
            : <img className="sponsor-img" src={url} alt="서버 스폰서 이미지" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        ) : <Empty>스폰서 이미지가 없습니다.</Empty>}
        {admin ? (
          <form className="inline-field" onSubmit={save}>
            <input type="url" placeholder="https://..." aria-label="스폰서 이미지 주소" maxLength={300} value={draft} disabled={!editable}
              onChange={(e) => setDraft(e.target.value)} />
            <button className="btn" type="submit" disabled={!editable || url == null || draft.trim() === url}>{draft.trim() ? '저장' : '지우기'}</button>
          </form>
        ) : null}
        <p className="muted small">게임 서버 목록에 보이는 배너입니다 (설정 문서의 ServerImageURL). 언제 반영되는지는 저장 후 알림에 표시됩니다.</p>
      </div>
    </Card>
  );
}

function EndpointsCard({ endpoints }: { endpoints: FeedEndpoint[] }) {
  return (
    <Card title="게임 서버 피드 엔드포인트" extra={<span className="muted small">게임 서버가 보고한 값 · 30초마다 갱신</span>}>
      <div className="card-body"><div className="table-wrap">
        <table className="table">
          <thead><tr><th>#</th><th>주소</th><th>상태</th><th className="num">대기</th><th className="num">전송 중</th><th className="num">연속 실패</th><th className="num">보냄</th><th className="num">유실</th><th>마지막 응답</th><th>마지막 성공</th></tr></thead>
          <tbody>
            {endpoints.map((e) => (
              <tr key={e.index}>
                <td className="num">{e.index + 1}</td>
                <td className="mono small">{`${e.scheme}${e.scheme ? '://' : ''}${e.host}`}</td>
                <td>{e.healthy ? <span className="chip" style={{ '--c': 'var(--ok)' } as CSSProperties}>정상</span> : <span className="chip" style={{ '--c': 'var(--danger)' } as CSSProperties}>실패</span>}</td>
                <td className="num">{fmtNum(e.queued)}</td>
                <td className="num">{fmtNum(e.inFlight)}</td>
                <td className={`num${e.consecutiveFailures ? ' danger' : ''}`}>{fmtNum(e.consecutiveFailures)}</td>
                <td className="num">{fmtNum(e.sentTotal)}</td>
                <td className={`num${e.droppedTotal ? ' danger' : ''}`}>{fmtNum(e.droppedTotal)}</td>
                <td className="mono">{e.lastHttpStatus ?? '—'}</td>
                <td className="nowrap">{e.lastSuccessAt ? fmtAgo(e.lastSuccessAt) : '없음'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div></div>
      <p className="card-foot muted small">유실은 게임 서버가 보내지 못하고 버린 이벤트 수입니다. 피드는 재전송이 없어 그만큼 킬 기록이 빠집니다.</p>
    </Card>
  );
}

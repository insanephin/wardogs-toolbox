import { useStore, can } from '../lib/store.ts';
import { toast } from '../lib/toast.ts';
import { fmtAgo, fmtNum } from '../lib/format.ts';
import { Card, Empty, useNow } from '../components/common.tsx';
import type { ReactNode } from 'react';
import type { Capabilities, Live } from '../lib/types.ts';

// What the game itself reports about its feed senders (GET /v1/feed), when the build serves it.
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
      {can('admin') ? (
        <Card title="피드 연결" extra={<button className="btn btn-sm" type="button" onClick={() => navigator.clipboard?.writeText(snippet).then(() => toast('복사했습니다'))}>복사</button>}>
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

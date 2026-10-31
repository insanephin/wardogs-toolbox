import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useStore, can, currentServer } from '../lib/store.ts';
import { api, run, errorMessage, refreshMe } from '../lib/api.ts';
import { modal, confirmAction } from '../lib/modal.tsx';
import { toast } from '../lib/toast.ts';
import { fmtAgo, fmtNum } from '../lib/format.ts';
import { Card, Empty, useNow } from '../components/common.tsx';
import type { ReactNode } from 'react';
import type { Capabilities, FeedEndpoint, Live, Member } from '../lib/types.ts';
import { ROLE_LABEL } from '../lib/labels.ts';
import { IconButton, Icon } from '../components/iconButton.tsx';
import { faCopy, faEye, faEyeSlash } from '@fortawesome/free-solid-svg-icons';

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
  const snippet = (token: string, serverName: string) => [
    'bEventFeedEnabled=True',
    '!EventFeedEndpoints=ClearArray',
    `.EventFeedEndpoints=(Url="${location.origin}/api/ingest/events",Token="${token}")`,
    `EventFeedServerName=${serverName}`,
  ].join('\n');
  const copySnippet = async () => {
    try {
      const { token } = await api<{ token: string }>('POST', '/api/feed-token');
      await navigator.clipboard.writeText(snippet(token, live?.status?.serverName ?? '<서버 이름>'));
      toast('복사했습니다');
    } catch (err) {
      toast(`복사하지 못했습니다: ${errorMessage(err)}`, 'error');
    }
  };

  const rotate = async () => {
    if (!(await confirmAction('피드 토큰 재발급', '지금 토큰은 바로 쓸 수 없게 됩니다. 게임 서버 ini의 EventFeedEndpoints 토큰을 새 값으로 바꿀 때까지 킬피드가 끊깁니다.', { confirm: '재발급' }))) return;
    try {
      const { token } = await api<{ token: string }>('POST', '/api/feed-token/rotate', {});
      await navigator.clipboard.writeText(token).catch(() => {});
      toast('새 토큰을 발급해 클립보드에 복사했습니다');
    } catch (err) {
      toast(`재발급 실패: ${errorMessage(err)}`, 'error');
    }
  };
  const kv = (rows: KvRow[]) => (
    <dl className="kv card-body">
      {rows.map(([k, v, cls]) => [<dt key={`${k}-t`}>{k}</dt>, <dd key={`${k}-d`} className={cls}>{v}</dd>])}
    </dl>
  );

  return (
    <div className="stack">
      <div className="grid-2">
        <Card title="RCON 상태">
          {kv([
            ['상태', live?.online ? '연결됨' : `끊김 ${live?.lastError ? `(${live.lastError.message})` : ''}`],
            ['폴링 주기', live ? `${live.intervalMs / 1000}초` : '—'],
            ['마지막 폴링', fmtAgo(live?.lastPollAt)],
            ['게임 빌드', caps?.build ?? '—', 'mono'],
            ...(caps?.version?.project?.version ? [['게임 버전', `${caps.version.project.name ?? ''} ${caps.version.project.version}`.trim()] as KvRow] : []),
            ['API 버전', caps?.apiVersion ?? '—'],
            ['요청 한도', caps?.limits ? `분당 ${fmtNum(caps.limits.maxRequestsPerMinutePerIp)}회 · 본문 ${fmtNum(caps.limits.maxBodyBytes)}바이트` : '—'],
            ['설정 쓰기', caps?.config ? (caps.config.writable ? '가능' : '불가') : '—'],
            live?.serverId ? ['접속 코드', live.serverId, 'mono'] : ['접속 코드', '없음', 'muted'],
          ])}
        </Card>
        <Card title="이벤트 피드 수신">
          {kv([
            ['마지막 배치', f?.lastBatchAt ? fmtAgo(f.lastBatchAt) : '받은 적 없음'],
            ['받은 배치', fmtNum(f?.batches ?? 0)],
            ['거부된 요청', fmtNum(f?.rejected ?? 0)],
            ['피드 서버 이름', f?.serverName ?? '—'],
            ['현재 매치 키', f?.matchKey ?? '—', 'mono small'],
            ['게임 서버 쪽 전송', gameFeedLabel(live?.gameFeed, caps), live?.gameFeed?.anyUnhealthy ? 'danger' : ''],
          ])}
        </Card>
      </div>
      {can('owner') ? <RconCard /> : null}
      {can('admin') && live?.gameFeed?.endpoints?.length ? <EndpointsCard endpoints={live.gameFeed.endpoints} /> : null}
      <SponsorCard />
      {can('admin') ? (
        <Card title="피드 연결" extra={
          <span className="inline-field">
            {can('owner') ? <button className="btn btn-sm" type="button" onClick={rotate}>토큰 재발급</button> : null}
            <IconButton icon={faCopy} label="토큰 포함 복사" onClick={copySnippet} />
          </span>
        }>
          <div className="card-body stack">
            <p className="muted small">ServerSettings.ini에 <code>[/Script/WDRCON.WDRCONSettings]</code> 줄 바로 밑에 복붙한 후 재시작하세요.</p>
            <pre className="code">{snippet('********', '********')}</pre>
          </div>
        </Card>
      ) : null}
      {can('admin') ? <DiscordBotCard /> : null}
      {can('owner') ? <DeleteServerCard /> : null}
    </div>
  );
}

const PANEL_KINDS = [
  { choice: '화이트리스트', label: '화이트리스트 패널', hint: '화이트리스트 인증(접속 우선권)' },
  { choice: '일반', label: '일반 유저 패널', hint: '서버 접속 · 신고' },
];
const panelCommand = (choice: string) => `/패널 종류:${choice}`;

const BOT_RESULTS: Record<string, { ok: boolean; text: string }> = {
  linked: { ok: true, text: '디스코드 서버에 봇을 추가하고 연결했습니다. 아래 명령어로 패널을 올리세요.' },
  denied: { ok: false, text: '이 서버의 관리자만 디스코드 서버를 연결할 수 있습니다. 체험 서버는 연결할 수 없습니다.' },
  cancelled: { ok: false, text: '디스코드 봇 추가를 취소했습니다.' },
  expired: { ok: false, text: '로그인이 만료되었습니다. 다시 시도해주세요.' },
  unconfigured: { ok: false, text: '대시보드에 디스코드 봇 설정이 없습니다.' },
};

interface DiscordBot {
  configured: boolean;
  demo: boolean;
  guild: { id: string; name: string } | null;
}

function DiscordBotCard() {
  const serverId = useStore((s) => s.serverId);
  const [bot, setBot] = useState<DiscordBot | null | undefined>(undefined);
  const [notice] = useState(() => {
    const code = new URLSearchParams(location.search).get('discord');
    return code ? BOT_RESULTS[code] ?? { ok: false, text: '디스코드 서버를 연결하지 못했습니다. 다시 시도해주세요.' } : null;
  });
  useEffect(() => {
    if (notice) history.replaceState(null, '', `/panel${location.hash}`);
  }, [notice]);
  const load = () => api<DiscordBot>('GET', '/api/discord-bot').then(setBot, () => setBot(null));
  useEffect(() => {
    load();
  }, [serverId]);

  const copy = async (choice: string) => {
    try {
      await navigator.clipboard.writeText(panelCommand(choice));
      toast('명령어를 복사했습니다');
    } catch (err) {
      toast(`복사하지 못했습니다: ${errorMessage(err)}`, 'error');
    }
  };
  const disconnect = async () => {
    if (!(await confirmAction('디스코드 서버 연결 해제', '이 디스코드 서버에서 새 패널을 올릴 수 없게 됩니다. 이미 올린 패널은 그대로 동작하고, 봇은 디스코드에서 직접 내보내야 합니다.', { confirm: '해제' }))) return;
    if (await run('디스코드 서버 연결 해제', 'DELETE', '/api/discord-guild')) load();
  };
  const connect = `/panel/discord-bot/${serverId}`;

  return (
    <Card title="디스코드 봇">
      <div className="card-body stack">
        {notice ? <div className={`banner ${notice.ok ? 'banner-ok' : 'banner-error'}`} role="status">{notice.text}</div> : null}
        <div className="stack">
          <p className="small"><strong>1. 디스코드 서버 연결</strong></p>
          {bot === undefined ? null : bot?.demo ? (
            <p className="muted small">체험 서버는 디스코드 서버와 연결할 수 없습니다. 실제 게임 서버를 등록한 뒤 연결하세요.</p>
          ) : !bot?.configured ? (
            <p className="muted small">봇을 추가하려면 대시보드 환경 변수 <code>DISCORD_BOT_CLIENT_ID</code>, <code>DISCORD_BOT_CLIENT_SECRET</code>, <code>DISCORD_BOT_SECRET</code>, <code>PUBLIC_URL</code>을 설정하세요.</p>
          ) : bot.guild ? (
            <>
              <span className="muted">{'연결된 디스코드 서버: '}<strong>{bot.guild.name}</strong></span>
              <div className="inline-field">
                <a className="btn btn-sm" href={connect}>다른 서버로 바꾸기</a>
                <button className="btn btn-sm" type="button" onClick={disconnect}>연결 해제</button>
              </div>
            </>
          ) : (
            <>
              <span className="muted">디스코드에서 패널을 올릴 서버를 고르면 봇이 추가되고 이 게임 서버와 연결됩니다. 디스코드 서버 관리 권한이 필요합니다.</span>
              <a className="btn btn-primary" href={connect}>디스코드 서버에 봇 추가</a>
            </>
          )}
        </div>
        {bot?.guild ? (
          <div className="stack">
            <p className="small"><strong>2. 패널 올리기</strong></p>
            <span className="muted">{`${bot.guild.name}에서 패널을 올릴 채널에 아래 명령어를 입력하세요. 서버 관리 권한이 있는 디스코드 멤버만 쓸 수 있습니다. 이 디스코드 서버에 게임 서버가 여러 개 연결돼 있으면 서버 옵션에서 고르세요.`}</span>
            <pre className="code">{panelCommand('일반')}</pre>
            <div className="inline-field">
              {PANEL_KINDS.map((k) => (
                <button key={k.choice} className="btn btn-sm" type="button" title={k.hint} onClick={() => copy(k.choice)}>
                  <Icon icon={faCopy} /> {`${k.label} 명령어 복사`}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function DeleteServerCard() {
  const server = useStore(currentServer);
  if (!server) return null;
  const remove = async () => {
    const v = await modal({
      title: '서버 삭제',
      body: <p>{`${server.name}의 킬 기록·감사 로그·신고·설정이 모두 지워지고 되돌릴 수 없습니다. 확인을 위해 서버 이름을 그대로 입력하세요.`}</p>,
      fields: [{ name: 'confirm', label: '서버 이름', required: true, placeholder: server.name }],
      confirm: '삭제',
      danger: true,
      hold: true,
    });
    if (!v) return;
    if (await run('서버 삭제', 'DELETE', '/api/server', { confirm: v.confirm })) {
      history.replaceState(null, '', location.pathname);
      refreshMe();
    }
  };

  const transfer = async () => {
    let members: Member[];
    try {
      members = await api<Member[]>('GET', '/api/members');
    } catch (err) {
      return toast(`관리자 목록을 불러오지 못했습니다: ${errorMessage(err)}`, 'error');
    }
    const candidates = members.filter((m) => m.role !== 'owner');
    if (!candidates.length) return toast('양도할 관리자가 없습니다. 관리자 탭에서 먼저 추가하세요', 'error');
    const v = await modal({
      title: '소유권 양도',
      body: <p>{`${server.name}의 소유자 권한을 넘깁니다. 지금 소유자는 관리자로 바뀌고, 되돌리려면 새 소유자가 다시 양도해야 합니다.`}</p>,
      fields: [{ name: 'steamId', label: '새 소유자', type: 'select', options: candidates.map((m) => ({ value: m.steamId, label: `${m.name ?? m.steamId} (${ROLE_LABEL[m.role]})` })) }],
      confirm: '양도',
      danger: true,
      hold: true,
    });
    if (!v) return;
    if (await run('소유권 양도', 'POST', '/api/owner', { steamId: v.steamId })) refreshMe();
  };

  return (
    <Card title="패널 관리">
      <div className="card-body"><div className="toolbar">
        <button className="btn btn-danger-outline" type="button" onClick={transfer}>소유권 양도</button>
        <button className="btn btn-danger-outline" type="button" onClick={remove}>서버 삭제</button>
      </div></div>
    </Card>
  );
}

type RconTarget = { url: string; passwordSet: boolean };

function RconCard() {
  const [saved, setSaved] = useState<RconTarget | null>(null);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false);

  const load = () => api<RconTarget>('GET', '/api/rcon').then((d) => {
    setSaved(d);
    setUrl(d.url);
    setPassword('');
  }, (err) => setError(errorMessage(err)));
  useEffect(() => {
    load();
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run('RCON 연결 정보', 'PUT', '/api/rcon', { url: url.trim(), password })) {
      setShown(false);
      load();
    }
  };

  const dirty = !!saved && (url.trim() !== saved.url || password !== '');

  return (
    <Card title="RCON 연결 정보">
      <div className="card-body stack">
        {error ? <Empty>불러오지 못했습니다: {error}</Empty> : (
          <form className="stack" onSubmit={save} autoComplete="off">
            <div className="inline-field">
              <input type={shown ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder="http://호스트:7776" aria-label="RCON 주소"
                maxLength={300} value={url} disabled={!saved} onChange={(e) => setUrl(e.target.value)} />
              <IconButton icon={shown ? faEyeSlash : faEye} label={shown ? '주소 가리기' : '주소 보기'} onClick={() => setShown(!shown)} />
            </div>
            <div className="inline-field">
              <input type="password" autoComplete="new-password" aria-label="RCON 비밀번호" maxLength={200} value={password} disabled={!saved}
                placeholder={saved?.passwordSet ? '설정됨 · 바꿀 때만 입력' : '비밀번호 입력'} onChange={(e) => setPassword(e.target.value)} />
              <button className="btn" type="submit" disabled={!dirty || !url.trim()}>저장</button>
            </div>
          </form>
        )}
      </div>
    </Card>
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
      </div>
    </Card>
  );
}

function EndpointsCard({ endpoints }: { endpoints: FeedEndpoint[] }) {
  return (
    <Card title="게임 서버 피드 엔드포인트">
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
    </Card>
  );
}

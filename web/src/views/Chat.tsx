import { memo, useEffect, useRef, useState } from 'react';
import type { ChatData, ChatMessage } from '../lib/types.ts';
import { useStore } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { fmtTime, fmtDateTime, fmtAgo } from '../lib/format.ts';
import { Card, Empty, Fdot, PageActions, useFactionColor } from '../components/common.tsx';
import { PlayerName } from '../components/playerName.tsx';
import { IconButton } from '../components/iconButton.tsx';
import { Spinner } from '../components/spinner.tsx';
import { faFilter, faXmark } from '@fortawesome/free-solid-svg-icons';
import { takeChatFocus } from '../lib/chatFocus.ts';
import type { ChatFocus } from '../lib/chatFocus.ts';

const PAGE = 150;
const CHANNEL_LABEL: Record<string, string> = { Global: '전체', Team: '팀', Squad: '분대', Proximity: '근처', Vehicle: '차량' };
const channelLabel = (c: string | null) => (c ? CHANNEL_LABEL[c] ?? c : '?');

function query(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  return `/api/chat?${q}`;
}

export default function Chat() {
  const tick = useStore((s) => s.chatTick);
  const collector = useStore((s) => s.live?.chat);
  const [rows, setRows] = useState<ChatMessage[] | null>(null);
  const [data, setData] = useState<Pick<ChatData, 'channels' | 'retentionDays'> | null>(null);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('');
  const [player, setPlayer] = useState<ChatFocus | null>(takeChatFocus);
  useEffect(() => {
    const onFocus = () => setPlayer(takeChatFocus());
    window.addEventListener('chatfocus', onFocus);
    return () => window.removeEventListener('chatfocus', onFocus);
  }, []);
  const [exhausted, setExhausted] = useState(false);
  const [loading, setLoading] = useState(false);
  const filters = { search, channel, steamId: player?.steamId };
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchText.trim()), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  useEffect(() => {
    let stale = false;
    setRows(null);
    setExhausted(false);
    api<ChatData>('GET', query({ ...filters, limit: PAGE })).then((d) => {
      if (stale) return;
      setRows(d.messages);
      setData({ channels: d.channels, retentionDays: d.retentionDays });
      setExhausted(d.messages.length < PAGE);
    }, () => !stale && setRows([]));
    return () => {
      stale = true;
    };
  }, [search, channel, player?.steamId]);

  useEffect(() => {
    const top = rowsRef.current?.[0];
    if (!tick || !rowsRef.current) return;
    const asked = filtersRef.current;
    api<ChatData>('GET', query({ ...asked, after: top?.id ?? 0, limit: 500 })).then((d) => {
      if (JSON.stringify(filtersRef.current) !== JSON.stringify(asked)) return;
      const fresh = d.messages.filter((m) => !rowsRef.current?.some((r) => r.id === m.id)).reverse();
      if (fresh.length) setRows((r) => [...fresh, ...(r ?? [])]);
      setData({ channels: d.channels, retentionDays: d.retentionDays });
    }, () => {});
  }, [tick]);

  const loadMore = async () => {
    const last = rows?.at(-1);
    if (!last || loading) return;
    setLoading(true);
    const d = await api<ChatData>('GET', query({ ...filters, before: last.id, limit: PAGE })).catch(() => null);
    if (d) {
      setRows((r) => [...(r ?? []), ...d.messages]);
      setExhausted(d.messages.length < PAGE);
    }
    setLoading(false);
  };

  return (
    <Card>
      <PageActions><CollectorStatus state={collector} /></PageActions>
      <div className="toolbar">
        <input type="search" placeholder="내용, 이름, 숨김 이름, SteamID" aria-label="채팅 검색" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
        <select aria-label="채널" value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="">모든 채널</option>
          {(data?.channels ?? []).map((c) => <option key={c} value={c}>{channelLabel(c)}</option>)}
        </select>
        {player ? (
          <span className="tag chat-only">
            {`${player.name}의 채팅만`}
            <IconButton icon={faXmark} label="플레이어 필터 해제" className="btn-ghost btn-xs" onClick={() => setPlayer(null)} />
          </span>
        ) : null}
        {data ? <span className="small muted toolbar-end">{`최근 ${data.retentionDays}일만 보관`}</span> : null}
      </div>
      <div className="card-body">
        <div className="table-wrap">
          {rows === null ? <Empty><Spinner /></Empty>
            : !rows.length ? <Empty>{emptyText(collector?.state, !!(search || channel || player))}</Empty>
            : (
              <div className="list-tight chat-list">
                {rows.map((m) => <ChatRow key={m.id} m={m} onlyThis={() => setPlayer(m.steamId ? { steamId: m.steamId, name: m.realName || m.steamId } : null)} />)}
                {exhausted ? null : (
                  <div className="row-center"><button className="btn btn-sm" type="button" disabled={loading} onClick={loadMore}>{loading ? '불러오는 중…' : '이전 채팅 더 보기'}</button></div>
                )}
              </div>
            )}
        </div>
      </div>
    </Card>
  );
}

function emptyText(state: string | undefined, filtered: boolean): string {
  if (filtered) return '조건에 맞는 채팅이 없습니다.';
  if (state === 'terms') return "채팅 약관 동의 전이라 게임 서버가 채팅을 주지 않습니다. '설정 › 연결 정보'에서 소유자가 동의하세요.";
  if (state === 'unsupported') return '이 게임 서버 빌드는 채팅 기록을 지원하지 않습니다 (0.3.0 이상 필요).';
  return '아직 기록된 채팅이 없습니다.';
}

function CollectorStatus({ state }: { state: { state: string; error: string | null; lastAt: number | null } | undefined }) {
  if (!state) return null;
  if (state.state === 'ok') return <span className="muted small">{`기록 중 · 마지막 확인 ${fmtAgo(state.lastAt)}`}</span>;
  if (state.state === 'terms') return <span className="danger small">기록 멈춤: 채팅 약관 미동의</span>;
  if (state.state === 'error') return <span className="danger small" title={state.error ?? undefined}>{`기록 오류 · 마지막 성공 ${fmtAgo(state.lastAt)}`}</span>;
  return <span className="muted small">이 빌드는 채팅 미지원</span>;
}

const ChatRow = memo(function ChatRow({ m, onlyThis }: { m: ChatMessage; onlyThis: () => void }) {
  const color = useFactionColor();
  const name = m.realName || m.steamId || '?';
  return (
    <div className={`kill chat-row${m.ping ? ' chat-ping' : ''}`}>
      <span className="kill-time" title={fmtDateTime(m.sentAt)}>{fmtTime(m.sentAt)}</span>
      <span className={`tag chat-ch chat-ch-${(m.channel ?? '').toLowerCase()}`}>{channelLabel(m.channel)}</span>
      <span className="who">
        <Fdot color={color(m.faction)} />
        <PlayerName className="kill-name" steamId={m.steamId} name={name} />
        {m.anonymous ? <span className="tag" title={`익명 모드: 다른 플레이어에게는 "${m.hiddenName ?? '?'}"(으)로 보였습니다`}>{`익명 · ${m.hiddenName ?? '?'}`}</span> : null}
      </span>
      <span className="chat-text">
        {m.ping ? <span className="tag" title="핑(콜아웃)으로 보낸 메시지">핑</span> : null}
        {m.text}
      </span>
      {m.steamId ? <IconButton icon={faFilter} label="이 플레이어 채팅만 보기" className="btn-ghost btn-xs" onClick={onlyThis} /> : <span />}
    </div>
  );
});

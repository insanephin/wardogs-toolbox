import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ChzzkOwner, LinkRow, OrError, Player, Streamer, Whitelist, WhitelistAudience, WhitelistBan, WhitelistMode } from '../lib/types.ts';
import { useStore, can, getState } from '../lib/store.ts';
import { api, run, errorMessage } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { fmtTime } from '../lib/format.ts';
import { Card, Empty, useOnAction } from '../components/common.tsx';
import { Spinner } from '../components/spinner.tsx';
import { SortTable } from '../components/sortTable.tsx';
import { IconButton } from '../components/iconButton.tsx';
import { KickMessage } from '../components/kickMessage.tsx';
import { faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { PlayerName } from '../components/playerName.tsx';

const WHITELIST_LABEL: Record<WhitelistMode, string> = { off: '꺼짐', kick: '미연동 킥', ban: '미연동 밴' };
const AUDIENCE_LABEL: Record<WhitelistAudience, string> = { linked: '계정 연동', follower: '치지직 팔로워', subscriber: '치지직 구독자' };
const BLOCKED_LABEL: Record<WhitelistAudience, string> = { linked: '미연동', follower: '미연동·미팔로우', subscriber: '미연동·미구독' };
const passes = (p: Player, audience: WhitelistAudience) => !!p.link && (audience === 'linked' || (audience === 'follower' ? p.follower : p.subscriber));

const OWNER_RESULTS: Record<string, { ok: boolean; text: string }> = {
  linked: { ok: true, text: '치지직 채널을 연결했습니다. 팔로워·구독자 목록을 받아오는 중입니다.' },
  denied: { ok: false, text: '이 서버의 관리자만 채널을 연결할 수 있습니다.' },
  cancelled: { ok: false, text: '치지직 로그인을 취소했습니다.' },
  expired: { ok: false, text: '로그인이 만료되었습니다. 다시 시도해주세요.' },
  unconfigured: { ok: false, text: '서버에 치지직 로그인 설정이 없습니다.' },
};

export default function Links() {
  const [links, setLinks] = useState<OrError<LinkRow[]> | null>(null);
  const [wl, setWl] = useState<Whitelist | null>(null);
  const [streamers, setStreamers] = useState<OrError<Streamer[]> | null>(null);
  const [search, setSearch] = useState('');
  const [notice] = useState(() => {
    const code = new URLSearchParams(location.search).get('owner');
    return code ? OWNER_RESULTS[code] ?? { ok: false, text: '치지직 채널을 연결하지 못했습니다. 다시 시도해주세요.' } : null;
  });
  useEffect(() => {
    if (notice) history.replaceState(null, '', `/panel${location.hash}`);
  }, [notice]);

  const load = useCallback(async () => {
    try {
      const [l, w] = await Promise.all([api<LinkRow[]>('GET', '/api/links'), api<Whitelist>('GET', '/api/whitelist')]);
      setLinks(l);
      setWl(w);
    } catch (err) {
      setLinks({ error: errorMessage(err) });
    }
    api<Streamer[]>('GET', '/api/streamers').then(setStreamers, (err) => setStreamers({ error: errorMessage(err) }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useOnAction((a) => (a.action.startsWith('whitelist_') || a.action.startsWith('chzzk_owner_') || a.action === 'unlink' || a.action === 'streamer_remove') && load());

  const q = search.trim().toLowerCase();
  const hit = (...vals: (string | null | undefined)[]) => !q || vals.some((v) => v && v.toLowerCase().includes(q));
  const streamerIds = new Set((Array.isArray(streamers) ? streamers : []).map((s) => s.steamId));
  const viewers = (Array.isArray(links) ? links : []).filter((l) => !streamerIds.has(l.steamId));
  const viewerRows = viewers.filter((l) => hit(l.steamId, l.steamName, l.lastName, l.chzzkName, l.chzzkChannelId));
  const loadError = links && !Array.isArray(links) ? links.error : streamers && !Array.isArray(streamers) ? streamers.error : null;

  return (
    <div className="grid-main">
      <Card title={`연동된 계정 ${viewers.length}`} extra={<IconButton icon={faRotateRight} label="새로고침" onClick={load} />}>
        <div className="toolbar">
          <input type="search" placeholder="스팀·치지직 이름 또는 ID" aria-label="연동 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="card-body"><div className="table-wrap">
          {!links || !streamers ? <Empty><Spinner /></Empty>
            : loadError ? <Empty>불러오지 못했습니다: {loadError}</Empty>
              : !viewerRows.length ? <Empty>{viewers.length ? '조건에 맞는 계정이 없습니다.' : '연동한 계정이 없습니다.'}</Empty>
                : <LinkTable rows={viewerRows} onChanged={load} />}
        </div></div>
      </Card>
      <div className="stack">
        {notice ? <div className={`banner ${notice.ok ? 'banner-ok' : 'banner-error'}`} role="status">{notice.text}</div> : null}
        <Card title="미연동 유저 차단">{wl ? <WhitelistForm wl={wl} onSaved={load} /> : <Empty><Spinner /></Empty>}</Card>
        <Card title="치지직 팔로워·구독자">{wl ? <OwnerForm owner={wl.owner} onChanged={load} /> : <Empty><Spinner /></Empty>}</Card>
        <Card title="미등록 유저 밴"><div className="card-body"><WhitelistBans list={wl?.bans} /></div></Card>
      </div>
    </div>
  );
}

function LinkTable({ rows, onChanged }: { rows: LinkRow[]; onChanged: () => void }) {
  const online = new Set((useStore((s) => s.live)?.players || []).map((p) => p.steamId));
  const mod = useStore((s) => !!s.me?.superadmin);
  const unlink = async (l: LinkRow) => {
    const name = l.lastName || l.steamName || l.steamId;
    if (!(await confirmAction('연동 해제', `${name}의 연동을 해제합니다. 미연동 유저 차단이 켜져 있으면 이 플레이어는 다시 등록하기 전까지 서버에 들어올 수 없습니다.`, { confirm: '해제' }))) return;
    if (await run('연동 해제', 'DELETE', `/api/links/${l.steamId}`)) onChanged();
  };
  return (
    <SortTable rows={rows} rowKey={(l) => l.steamId} initial={{ key: 'linkedAt', dir: -1 }} columns={[
      { key: 'steam', label: '스팀', sort: (l) => l.lastName || l.steamName, render: (l) => (
        <>
          <div className="pname">
            <PlayerName steamId={l.steamId} name={l.lastName || l.steamName} />
            {online.has(l.steamId) ? <> <span className="tag tag-hs">접속 중</span></> : null}
          </div>
          <div className="mono muted small">{l.steamId}</div>
        </>
      ) },
      { key: 'chzzk', label: '치지직', sort: (l) => l.chzzkName || l.chzzkChannelId, render: (l) => (
        <PlayerName className="tag tag-chzzk" steamId={l.steamId} name={l.lastName || l.steamName}>{l.chzzkName || l.chzzkChannelId}</PlayerName>
      ) },
      { key: 'linkedAt', label: '연동 시각', desc: true, sort: (l) => l.linkedAt, className: 'muted small nowrap', render: (l) => fmtTime(l.linkedAt) },
      ...(mod ? [{ key: 'actions', label: <span className="sr-only">작업</span>, className: 'actions', render: (l: LinkRow) => (
        <button className="btn btn-sm btn-danger-outline" type="button" onClick={() => unlink(l)}>연동 해제</button>
      ) }] : []),
    ]} />
  );
}

function WhitelistForm({ wl, onSaved }: { wl: Whitelist; onSaved: () => void }) {
  const [mode, setMode] = useState(wl.mode);
  const [message, setMessage] = useState(wl.message);
  const [audience, setAudience] = useState(wl.audience);
  const editable = can('admin');
  const players = (useStore((s) => s.live)?.players || []).filter((p) => p.steamId && !p.streamer);
  const blocked = (a: WhitelistAudience) => players.filter((p) => !passes(p, a)).length;
  const blockedOnline = blocked(audience);
  const messageEditable = editable && mode !== 'off';
  const available: Record<WhitelistAudience, boolean> = {
    linked: true,
    follower: !!wl.owner?.followerSyncedAt || wl.audience === 'follower',
    subscriber: !!wl.owner?.syncedAt || wl.audience === 'subscriber',
  };
  const dirty = mode !== wl.mode || audience !== wl.audience || (messageEditable && message !== wl.message);
  const stricter = mode !== 'off' && (mode !== wl.mode || blockedOnline > blocked(wl.audience));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (stricter && blockedOnline > 0 && !(await confirmAction('미연동 유저 차단 켜기',
      `지금 접속 중인 ${BLOCKED_LABEL[audience]} 플레이어 ${blockedOnline}명이 바로 ${mode === 'ban' ? '밴·킥' : '킥'}됩니다.`, { confirm: '적용' }))) return;
    if (await run('미연동 유저 차단', 'PUT', '/api/whitelist', { mode, audience, message: mode === 'off' ? wl.message : message.trim() })) onSaved();
  };

  return (
    <form className="card-body stack" onSubmit={save}>
      <div className="seg" role="radiogroup" aria-label="미연동 유저 차단 모드">
        {(Object.entries(WHITELIST_LABEL) as [WhitelistMode, string][]).map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={mode === id} className={mode === id ? 'on' : ''} disabled={!editable} onClick={() => setMode(id)}>{label}</button>
        ))}
      </div>
      <div className="field">
        <span className="field-label"><span>{`입장 조건${wl.owner ? ` (${wl.owner.channelName})` : ''}`}</span></span>
        <div className="seg" role="radiogroup" aria-label="입장 조건">
          {(Object.entries(AUDIENCE_LABEL) as [WhitelistAudience, string][]).map(([id, label]) => (
            <button key={id} type="button" role="radio" aria-checked={audience === id} className={audience === id ? 'on' : ''}
              disabled={!editable || !available[id]} onClick={() => setAudience(id)}>{label}</button>
          ))}
        </div>
      </div>
      {!available.follower || !available.subscriber ? (
        <p className="muted small">{wl.owner ? '치지직 팔로워·구독자 조건은 아래 채널에서 해당 목록을 한 번 받아온 뒤에 고를 수 있습니다.' : '아래에서 치지직 채널을 연결하면 팔로워·구독자 조건을 고를 수 있습니다.'}</p>
      ) : null}
      <KickMessage label="안내 문구 (킥·밴 사유)" rows={3} value={mode === 'off' ? wl.message : message} disabled={!messageEditable} onChange={setMessage} />
      {mode !== 'off' ? <p className="small">{`접속 중인 ${BLOCKED_LABEL[audience]} 플레이어 ${blockedOnline}명`}</p> : null}
      {editable ? <div><button className="btn" type="submit" disabled={!dirty || (messageEditable && !message.trim())}>저장</button></div> : null}
    </form>
  );
}

function OwnerForm({ owner, onChanged }: { owner: ChzzkOwner | null; onChanged: () => void }) {
  const editable = can('admin');
  const [syncing, setSyncing] = useState(false);
  const connect = `/panel/chzzk-owner/${getState().serverId}`;

  const sync = async () => {
    setSyncing(true);
    await run('팔로워·구독자 목록 동기화', 'POST', '/api/chzzk-owner/sync');
    setSyncing(false);
    onChanged();
  };
  const disconnect = async () => {
    if (!(await confirmAction('채널 연결 해제', '팔로워·구독자 목록을 지우고 입장 조건을 "계정 연동"으로 되돌립니다.', { confirm: '해제' }))) return;
    if (await run('채널 연결 해제', 'DELETE', '/api/chzzk-owner')) onChanged();
  };

  if (!owner) {
    return (
      <div className="card-body stack">
        <p className="muted small">스트리머 본인이 치지직으로 로그인하면, 그 채널의 팔로워·구독자 목록을 3분마다 받아와 화이트리스트 조건으로 쓸 수 있습니다.</p>
        {editable ? <div><a className="btn" href={connect}>스트리머 치지직 연결</a></div> : null}
      </div>
    );
  }
  return (
    <div className="card-body stack">
      <dl className="kv">
        <dt>채널</dt>
        <dd><span className="tag tag-chzzk">{owner.channelName}</span></dd>
        <dt>구독자</dt>
        <dd>{owner.syncedAt ? `${owner.count}명 · ${fmtTime(owner.syncedAt)} 기준` : '받아오는 중'}</dd>
        <dt>팔로워</dt>
        <dd>{owner.followerSyncedAt ? `${owner.followerCount}명 · ${fmtTime(owner.followerSyncedAt)} 기준` : '받아오는 중'}</dd>
      </dl>
      {owner.error ? <div className="small danger">{`구독자 동기화 실패 (마지막 목록 유지 중): ${owner.error}`}</div> : null}
      {owner.followerError ? <div className="small danger">{`팔로워 동기화 실패 (마지막 목록 유지 중): ${owner.followerError}`}</div> : null}
      {editable ? (
        <div className="toolbar">
          <button className="btn" type="button" disabled={syncing} onClick={sync}>{syncing ? '받아오는 중' : '지금 동기화'}</button>
          <a className="btn" href={connect}>다시 연결</a>
          <button className="btn btn-danger-outline" type="button" onClick={disconnect}>연결 해제</button>
        </div>
      ) : null}
    </div>
  );
}

function WhitelistBans({ list }: { list: WhitelistBan[] | undefined }) {
  if (!list) return null;
  if (!list.length) return <Empty>목록이 비어있습니다.</Empty>;
  return (
    <ul className="plain-list">
      {list.map((b) => (
        <li key={b.steamId}>
          <div>{b.name ? <PlayerName steamId={b.steamId} name={b.name} /> : <PlayerName steamId={b.steamId} name={null}>—</PlayerName>} <span className="mono muted small">{b.steamId}</span></div>
          <div className="muted small">{`${fmtTime(b.createdAt)}${b.linked ? ' · 조건 충족, 곧 해제' : ''}`}</div>
          {b.lastError ? <div className="small danger">해제 실패: {b.lastError}</div> : null}
        </li>
      ))}
    </ul>
  );
}

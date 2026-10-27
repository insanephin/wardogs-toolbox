import { useEffect, useRef, useState } from 'react';
import type { Link, Player, PlayerProfile, Streamer } from '../lib/types.ts';
import { useStore, getState, can, serves } from '../lib/store.ts';
import { api, run } from '../lib/api.ts';
import { modal, confirmAction, openDialog, Overlay } from '../lib/modal.tsx';
import { fmtNum, fmtDuration, fmtTime, pct } from '../lib/format.ts';
import { Card, PageActions, Empty, FactionChip, Fdot, Avatar, useNow, useFactionColor } from '../components/common.tsx';
import { SortTable } from '../components/sortTable.tsx';

export default function Players() {
  const live = useStore((s) => s.live);
  const color = useFactionColor();
  const now = useNow();
  const [faction, setFaction] = useState('');
  const [search, setSearch] = useState('');

  const stats = new Map((live?.matchStats || []).map((r) => [r.steamId, r]));
  const q = search.trim().toLowerCase();
  const list = (live?.players || [])
    .filter((p) => !faction || p.faction === faction)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.steamId.includes(q) || p.link?.chzzkName?.toLowerCase().includes(q))
    .map((p) => {
      const s = stats.get(p.steamId);
      return {
        ...p,
        kd: p.deaths ? p.kills / p.deaths : p.kills,
        hs: s ? pct(s.headshots, s.kills) : null,
        session: p.joinedAt ? (now - p.joinedAt) / 1000 : null,
        linked: p.streamer ? `0${p.streamer.discordName ?? ''}` : p.link ? `1${p.link.chzzkName ?? p.link.chzzkChannelId}` : '',
      };
    });

  const factionNames = (live?.status?.factionScores || []).map((f) => f.name);
  const counts: Record<string, number> = {};
  for (const p of live?.players || []) counts[p.faction ?? ''] = (counts[p.faction ?? ''] ?? 0) + 1;

  return (
    <Card>
      <PageActions><span className="muted small">{live?.status ? `${live.status.players.current} / ${live.status.players.max}명 접속` : ''}</span></PageActions>
      <div className="toolbar">
        <input type="search" placeholder="이름, SteamID 또는 치지직" aria-label="플레이어 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="seg" role="group" aria-label="진영 필터">
          <button type="button" className={faction ? '' : 'on'} onClick={() => setFaction('')}>{`전체 ${live?.players?.length ?? 0}`}</button>
          {factionNames.map((n) => (
            <button key={n} type="button" className={faction === n ? 'on' : ''} onClick={() => setFaction(n)}>
              <Fdot color={color(n)} />{`${n} ${counts[n] ?? 0}`}
            </button>
          ))}
        </div>
      </div>
      <div className="card-body">
        <div className="table-wrap">
          {!list.length ? (
            <Empty>{live?.mapTransition ? '맵 로딩 중이라 플레이어 목록이 비어 보입니다.' : '조건에 맞는 플레이어가 없습니다.'}</Empty>
          ) : (
            <SortTable rows={list} rowKey={(p) => p.steamId} initial={{ key: 'kills', dir: -1 }} columns={[
              { key: 'name', label: '플레이어', sort: (p) => p.name, render: (p) => (
                <div className="who"><Avatar src={p.avatar} /><div><div className="pname">{p.name}</div><div className="mono muted small">{p.steamId}</div></div></div>
              ) },
              { key: 'linked', label: '연동', sort: (p) => p.linked, render: (p) => <LinkCell link={p.link} streamer={p.streamer} /> },
              { key: 'faction', label: '진영', sort: (p) => p.faction, render: (p) => <FactionChip name={p.faction} color={color(p.faction)} /> },
              { key: 'kills', label: '킬', num: true, sort: (p) => p.kills, render: (p) => p.kills },
              { key: 'deaths', label: '데스', num: true, sort: (p) => p.deaths, render: (p) => p.deaths },
              { key: 'kd', label: 'K/D', num: true, sort: (p) => p.kd, render: (p) => p.kd.toFixed(2) },
              { key: 'hs', label: 'HS%', num: true, sort: (p) => p.hs, render: (p) => <span className={(p.hs ?? 0) >= 60 ? 'warn-text' : undefined}>{p.hs == null ? '—' : `${p.hs}%`}</span> },
              { key: 'cash', label: '돈', num: true, sort: (p) => p.cash, render: (p) => (live?.cashUnreliable ? '—' : fmtNum(p.cash)) },
              { key: 'pingMs', label: '핑', num: true, sort: (p) => p.pingMs, render: (p) => <span className={`ping-${p.pingMs >= 200 ? 'bad' : p.pingMs >= 120 ? 'mid' : 'ok'}`}>{p.pingMs}ms</span> },
              { key: 'session', label: '접속', num: true, sort: (p) => p.session, render: (p) => fmtDuration(p.session) },
              { key: 'actions', label: <span className="sr-only">작업</span>, className: 'actions', render: (p) => <button className="btn btn-sm" type="button" onClick={() => openPlayer(p)}>관리</button> },
            ]} />
          )}
        </div>
      </div>
    </Card>
  );
}

function LinkCell({ link, streamer }: { link: Link | null; streamer: Streamer | null }) {
  if (streamer) return <div className="small"><span className="tag tag-streamer">화이트리스트</span>{link ? `치지직 ${link.chzzkName || link.chzzkChannelId}` : streamer.discordName}</div>;
  if (!link) return <span className="tag tag-danger">미연동</span>;
  return <div className="small">{`치지직 ${link.chzzkName || link.chzzkChannelId}`}</div>;
}

async function openPlayer(p: Player) {
  const profile = await api<PlayerProfile>('GET', `/api/players/${p.steamId}/profile`).catch(() => null);
  openDialog((close) => <PlayerDialog p={p} profile={profile} close={close} />);
}

function PlayerDialog({ p, profile, close }: { p: Player; profile: PlayerProfile | null; close: () => void }) {
  const caps = useStore((s) => s.caps);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  const t: PlayerProfile['totals'] = profile?.totals || {};
  const canMove = serves(caps, 'PATCH /v1/players/{id}');

  const act = (fn: () => Promise<void>) => async () => {
    close();
    await fn();
  };

  return (
    <Overlay label={`${p.name} 관리`} onClose={close}>
      <h2>플레이어 관리</h2>
      <div className="modal-body">
        <div className="profile">
          <div>
            <div className="pname-lg">{p.name}</div>
            <div className="mono muted">{p.steamId}</div>
            <a href={`https://steamcommunity.com/profiles/${p.steamId}`} target="_blank" rel="noopener noreferrer" className="link small">Steam 프로필 열기</a>
          </div>
          <div className="profile-stats">
            <div><b>{fmtNum(t.kills ?? 0)}</b><span>누적 킬</span></div>
            <div><b>{fmtNum(t.deaths ?? 0)}</b><span>누적 데스</span></div>
            <div><b>{`${pct(t.headshots ?? 0, t.kills ?? 0) ?? 0}%`}</b><span>헤드샷</span></div>
            <div><b>{fmtNum(t.teamkills ?? 0)}</b><span>팀킬 추정</span></div>
          </div>
        </div>
        <InfoTable link={p.link} streamer={p.streamer} seen={profile?.player ?? null} />
        {profile && profile.names.length > 1 ? <p className="small">사용한 이름: {profile.names.map((n) => n.name).join(', ')}</p> : null}
        {profile?.weapons?.length ? <p className="small">주무기: {profile.weapons.slice(0, 5).map((w) => `${w.weapon} ${w.kills}`).join(', ')}</p> : null}
        {can('mod') ? (
          <div className="action-grid">
            <button type="button" className="btn" onClick={act(() => whisper(p))}>귓속말</button>
            <button type="button" className="btn" disabled={!canMove} title={canMove ? undefined : '이 서버 빌드는 진영 이동을 지원하지 않습니다'} onClick={act(() => moveFaction(p))}>진영 이동</button>
            <button type="button" className="btn btn-danger-outline" onClick={act(() => killPlayer(p))}>킬</button>
            <button type="button" className="btn btn-danger-outline" onClick={act(() => kick(p))}>킥</button>
            <button type="button" className="btn btn-danger-outline" onClick={act(() => ban(p))}>밴</button>
          </div>
        ) : null}
      </div>
      <div className="modal-actions"><button ref={closeRef} className="btn" type="button" onClick={close}>닫기</button></div>
    </Overlay>
  );
}

function InfoTable({ link, streamer, seen }: { link: Link | null; streamer: Streamer | null; seen: PlayerProfile['player'] }) {
  return (
    <table className="table table-info small">
      <tbody>
        {streamer ? (
          <tr>
            <th scope="row">화이트리스트</th>
            <td><span className="tag tag-streamer">디스코드 인증</span>{`${streamer.discordName ?? streamer.discordId} · ${streamer.reserved ? '접속 우선권 적용' : '우선권 적용 대기'}`}</td>
          </tr>
        ) : null}
        <tr>
          <th scope="row">치지직</th>
          <td>{link
            ? <a className="link" href={`https://chzzk.naver.com/${link.chzzkChannelId}`} target="_blank" rel="noopener noreferrer">{link.chzzkName || link.chzzkChannelId}</a>
            : <span className="tag tag-danger">미연동</span>}</td>
        </tr>
        {link ? <tr><th scope="row">스팀 이름</th><td>{link.steamName ?? '—'}</td></tr> : null}
        <tr><th scope="row">인증 시간</th><td>{fmtTime(link?.linkedAt)}</td></tr>
        <tr><th scope="row">최초 접속</th><td>{fmtTime(seen?.first_seen)}</td></tr>
        <tr><th scope="row">마지막 접속</th><td>{fmtTime(seen?.last_seen)}</td></tr>
        <tr><th scope="row">세션</th><td>{seen ? `${seen.sessions}회` : '—'}</td></tr>
      </tbody>
    </table>
  );
}

async function whisper(p: Player) {
  const v = await modal({ title: `${p.name}에게 귓속말`, fields: [{ name: 'message', label: '메시지', type: 'textarea', max: 256, required: true }], confirm: '보내기' });
  if (v) await run('귓속말', 'POST', `/api/players/${p.steamId}/message`, { message: v.message, name: p.name });
}

async function kick(p: Player) {
  const v = await modal({
    title: `${p.name} 킥`, danger: true, confirm: '킥',
    fields: [{ name: 'reason', label: '사유 (플레이어에게 보임)', max: 200, required: true }],
  });
  if (v) await run('킥', 'POST', `/api/players/${p.steamId}/kick`, { reason: v.reason, name: p.name });
}

async function killPlayer(p: Player) {
  if (await confirmAction(`${p.name} 킬`, '이 플레이어를 즉시 사망 처리합니다.')) {
    await run('킬', 'POST', `/api/players/${p.steamId}/kill`, { name: p.name });
  }
}

async function moveFaction(p: Player) {
  const options = (getState().live?.status?.factionScores || []).filter((f) => f.name !== p.faction).map((f) => ({ value: f.name, label: f.name }));
  const v = await modal({
    title: `${p.name} 진영 이동`,
    body: <p className="muted small">이동 후 사망 처리됩니다.</p>,
    fields: [{ name: 'faction', label: '옮길 진영', type: 'select', options }],
    confirm: '이동',
  });
  if (v) await run('진영 이동', 'POST', `/api/players/${p.steamId}/faction`, { faction: v.faction, name: p.name });
}

async function ban(p: Player) {
  const v = await modal({
    title: `${p.name ?? p.steamId} 밴`, danger: true, hold: true, confirm: '밴',
    body: <p className="muted small">밴 후 즉시 킥합니다.</p>,
    fields: [{ name: 'reason', label: '사유', max: 200 }],
  });
  if (v) await run('밴', 'POST', '/api/bans', { steamId: p.steamId, reason: v.reason });
}

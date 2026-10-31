import { useEffect, useRef } from 'react';
import type { Link, Player, PlayerProfile, Streamer } from '../lib/types.ts';
import { useStore, getState, can, serves } from '../lib/store.ts';
import { api, run } from '../lib/api.ts';
import { modal, confirmAction, openDialog, Overlay } from '../lib/modal.tsx';
import { fmtNum, fmtTime, pct } from '../lib/format.ts';

export async function openPlayer(p: Player, online = true) {
  const profile = await api<PlayerProfile>('GET', `/api/players/${p.steamId}/profile`).catch(() => null);
  openDialog((close) => <PlayerDialog p={p} profile={profile} online={online} close={close} />);
}

export async function openPlayerById(steamId: string, known: { name?: string | null; link?: Link | null } = {}) {
  const live = getState().live?.players?.find((x) => x.steamId === steamId);
  if (live) return openPlayer(live);
  const offline: Player = {
    steamId, name: known.name || steamId, kills: 0, deaths: 0, pingMs: 0, joinedAt: null,
    link: known.link ?? null, subscriber: false, follower: false, streamer: null, avatar: null,
  };
  return openPlayer(offline, false);
}

function PlayerDialog({ p, profile, online, close }: { p: Player; profile: PlayerProfile | null; online: boolean; close: () => void }) {
  const caps = useStore((s) => s.caps);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  const t: PlayerProfile['totals'] = profile?.totals || {};
  const canMove = serves(caps, 'PATCH /v1/players/{id}');
  const offlineTip = online ? undefined : '서버에 접속 중일 때만 쓸 수 있습니다';

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
            <div className="pname-lg" title={p.steamId}>{p.name}{online ? null : <span className="tag">접속 중 아님</span>}</div>
          </div>
          <div className="profile-stats">
            <div><b>{fmtNum(t.kills ?? 0)}</b><span>누적 킬</span></div>
            <div><b>{fmtNum(t.deaths ?? 0)}</b><span>누적 데스</span></div>
            <div><b>{`${pct(t.headshots ?? 0, t.kills ?? 0) ?? 0}%`}</b><span>헤드샷</span></div>
            <div><b>{fmtNum(t.teamkills ?? 0)}</b><span>팀킬 추정</span></div>
          </div>
        </div>
        <InfoTable steamId={p.steamId} name={p.name} link={p.link} streamer={p.streamer} seen={profile?.player ?? null} />
        {profile && profile.names.length > 1 ? <p className="small">사용한 이름: {profile.names.map((n) => n.name).join(', ')}</p> : null}
        {profile?.weapons?.length ? <p className="small">주무기: {profile.weapons.slice(0, 5).map((w) => `${w.weapon} ${w.kills}`).join(', ')}</p> : null}
        {can('mod') ? (
          <div className="action-grid">
            <button type="button" className="btn" disabled={!online} title={offlineTip} onClick={act(() => whisper(p))}>귓속말</button>
            <button type="button" className="btn" disabled={!online || !canMove} title={offlineTip ?? (canMove ? undefined : '이 서버 빌드는 진영 이동을 지원하지 않습니다')} onClick={act(() => moveFaction(p))}>진영 이동</button>
            <button type="button" className="btn btn-danger-outline" disabled={!online} title={offlineTip} onClick={act(() => killPlayer(p))}>킬</button>
            <button type="button" className="btn btn-danger-outline" disabled={!online} title={offlineTip} onClick={act(() => kick(p))}>킥</button>
            <button type="button" className="btn btn-danger-outline" onClick={act(() => ban(p))}>밴</button>
          </div>
        ) : null}
      </div>
      <div className="modal-actions"><button ref={closeRef} className="btn" type="button" onClick={close}>닫기</button></div>
    </Overlay>
  );
}

function InfoTable({ steamId, name, link, streamer, seen }: { steamId: string; name: string; link: Link | null; streamer: Streamer | null; seen: PlayerProfile['player'] }) {
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
            ? <a className="tag tag-chzzk" href={`https://chzzk.naver.com/${link.chzzkChannelId}`} target="_blank" rel="noopener noreferrer">{link.chzzkName || link.chzzkChannelId}</a>
            : <span className="tag tag-danger">미연동</span>}</td>
        </tr>
        <tr>
          <th scope="row">스팀</th>
          <td><a className="tag tag-steam" href={`https://steamcommunity.com/profiles/${steamId}`} target="_blank" rel="noopener noreferrer" title={steamId}>{link?.steamName || name}</a></td>
        </tr>
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

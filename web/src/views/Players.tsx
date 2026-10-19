import { useEffect, useRef, useState } from 'react';
import type { Link, Player, PlayerProfile } from '../lib/types.ts';
import { useStore, getState, can, serves } from '../lib/store.ts';
import { api, run } from '../lib/api.ts';
import { modal, confirmAction, openDialog, Overlay } from '../lib/modal.tsx';
import { fmtNum, fmtDuration, fmtTime, pct } from '../lib/format.ts';
import { Card, Empty, FactionChip, Fdot, useNow, useFactionColor } from '../components/common.tsx';

type SortKey = 'name' | 'linked' | 'faction' | 'kills' | 'deaths' | 'kd' | 'hs' | 'cash' | 'pingMs' | 'session';

const COLUMNS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: 'name', label: '플레이어' },
  { key: 'linked', label: '연동' },
  { key: 'faction', label: '진영' },
  { key: 'kills', label: '킬', num: true },
  { key: 'deaths', label: '데스', num: true },
  { key: 'kd', label: 'K/D', num: true },
  { key: 'hs', label: 'HS%', num: true },
  { key: 'cash', label: '돈', num: true },
  { key: 'pingMs', label: '핑', num: true },
  { key: 'session', label: '접속', num: true },
];

export default function Players() {
  const live = useStore((s) => s.live);
  const color = useFactionColor();
  const now = useNow();
  const [sort, setSort] = useState<{ key: SortKey; dir: number }>({ key: 'kills', dir: -1 });
  const [faction, setFaction] = useState('');
  const [search, setSearch] = useState('');

  const stats = new Map((live?.matchStats || []).map((r) => [r.steamId, r]));
  const q = search.trim().toLowerCase();
  const list = (live?.players || [])
    .filter((p) => !faction || p.faction === faction)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.steamId.includes(q) || p.link?.discordName?.toLowerCase().includes(q))
    .map((p) => {
      const s = stats.get(p.steamId);
      return {
        ...p,
        kd: p.deaths ? p.kills / p.deaths : p.kills,
        hs: s ? pct(s.headshots, s.kills) : null,
        session: p.joinedAt ? (now - p.joinedAt) / 1000 : null,
        linked: p.link?.discordName ?? (p.link ? p.link.discordId : ''),
      };
    })
    .sort((a, b) => {
      const av = a[sort.key] ?? -1;
      const bv = b[sort.key] ?? -1;
      return (typeof av === 'string' ? av.localeCompare(String(bv)) : av - Number(bv)) * sort.dir;
    });

  const factionNames = (live?.status?.factionScores || []).map((f) => f.name);
  const counts: Record<string, number> = {};
  for (const p of live?.players || []) counts[p.faction ?? ''] = (counts[p.faction ?? ''] ?? 0) + 1;

  return (
    <Card title="접속 중인 플레이어" extra={<span className="muted small">{live?.status ? `${live.status.players.current} / ${live.status.players.max}명` : ''}</span>}>
      <div className="toolbar">
        <input type="search" placeholder="이름, SteamID 또는 디스코드" aria-label="플레이어 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
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
            <table className="table">
              <thead>
                <tr>
                  {COLUMNS.map((c) => {
                    const active = sort.key === c.key;
                    return (
                      <th key={c.key} className={c.num ? 'num' : ''} aria-sort={active ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                        <button type="button" className="th-sort" onClick={() => setSort({ key: c.key, dir: active ? -sort.dir : c.num ? -1 : 1 })}>
                          {c.label}{active ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
                        </button>
                      </th>
                    );
                  })}
                  <th><span className="sr-only">작업</span></th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.steamId}>
                    <td><div className="pname">{p.name}</div><div className="mono muted small">{p.steamId}</div></td>
                    <td><LinkCell link={p.link} /></td>
                    <td><FactionChip name={p.faction} color={color(p.faction)} /></td>
                    <td className="num">{p.kills}</td>
                    <td className="num">{p.deaths}</td>
                    <td className="num">{p.kd.toFixed(2)}</td>
                    <td className={`num${(p.hs ?? 0) >= 60 ? ' warn-text' : ''}`}>{p.hs == null ? '—' : `${p.hs}%`}</td>
                    <td className="num">{live?.cashUnreliable ? '—' : fmtNum(p.cash)}</td>
                    <td className={`num ping-${p.pingMs >= 200 ? 'bad' : p.pingMs >= 120 ? 'mid' : 'ok'}`}>{p.pingMs}ms</td>
                    <td className="num">{fmtDuration(p.session)}</td>
                    <td className="actions"><button className="btn btn-sm" type="button" onClick={() => openPlayer(p)}>관리</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      <p className="card-foot muted small">플레이어는 항상 SteamID로 식별합니다. 접속 직후 1분은 클랜 태그가 붙기 전이라 이름이 바뀔 수 있고, 익명 모드는 같은 이름이 여럿일 수 있습니다.</p>
    </Card>
  );
}

function LinkCell({ link }: { link: Link | null }) {
  if (!link) return <span className="tag tag-danger">미연동</span>;
  return (
    <>
      <div className="small">{link.discordName || link.discordId}</div>
      {link.chzzkName ? <div className="muted small">{`치지직 ${link.chzzkName}`}</div> : null}
    </>
  );
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

  // Close first so the follow-up dialog isn't stacked on top of this one.
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
        <LinkInfo link={p.link} />
        {profile?.player ? <p className="muted small">{`처음 본 날 ${fmtTime(profile.player.first_seen)} · 세션 ${profile.player.sessions}회`}</p> : null}
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
        ) : <p className="muted small">뷰어 권한은 조회만 가능합니다.</p>}
      </div>
      <div className="modal-actions"><button ref={closeRef} className="btn" type="button" onClick={close}>닫기</button></div>
    </Overlay>
  );
}

function LinkInfo({ link }: { link: Link | null }) {
  if (!link) return <p className="small"><span className="tag tag-danger">미연동</span> 디스코드에서 스팀 계정을 연동하지 않았습니다.</p>;
  return (
    <dl className="kv small">
      <dt>디스코드</dt><dd>{link.discordName || '—'} <span className="mono muted">{link.discordId}</span></dd>
      <dt>스팀 연동</dt><dd>{`${link.steamName ?? '—'} · ${fmtTime(link.steamLinkedAt)}`}</dd>
      <dt>치지직</dt>
      <dd>{link.chzzkChannelId
        ? <a className="link" href={`https://chzzk.naver.com/${link.chzzkChannelId}`} target="_blank" rel="noopener noreferrer">{link.chzzkName || link.chzzkChannelId}</a>
        : <span className="muted">미연동</span>}</dd>
    </dl>
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
    body: <p className="muted small">이동 후 새 진영에서 리스폰하도록 사망 처리됩니다. Season 2에서는 한 팀이 10점 넘게 앞설 때 게임 자체 팀 변경 제한(15분)이 걸려 있을 수 있습니다.</p>,
    fields: [{ name: 'faction', label: '옮길 진영', type: 'select', options }],
    confirm: '이동',
  });
  if (v) await run('진영 이동', 'POST', `/api/players/${p.steamId}/faction`, { faction: v.faction, name: p.name });
}

async function ban(p: Player) {
  const v = await modal({
    title: `${p.name ?? p.steamId} 밴`, danger: true, confirm: '밴',
    body: <p className="muted small">밴 후 즉시 킥합니다. 해제는 모더레이션 탭에서 할 수 있습니다.</p>,
    fields: [{ name: 'reason', label: '사유', max: 200 }],
  });
  if (v) await run('밴', 'POST', '/api/bans', { steamId: p.steamId, reason: v.reason });
}

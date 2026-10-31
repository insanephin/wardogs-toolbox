import { useState } from 'react';
import type { Link, Streamer } from '../lib/types.ts';
import { openPlayer } from '../components/playerDialog.tsx';
import { PlayerName } from '../components/playerName.tsx';
import { useStore } from '../lib/store.ts';
import { fmtNum, fmtDuration, pct } from '../lib/format.ts';
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
    .filter((p) => !q || [p.name, p.steamId, p.link?.chzzkName].some((v) => v?.toLowerCase().includes(q)))
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
                <div className="who"><Avatar src={p.avatar} /><div><PlayerName className="pname" steamId={p.steamId} name={p.name} /><div className="mono muted small">{p.steamId}</div></div></div>
              ) },
              { key: 'linked', width: '18%', label: '연동', sort: (p) => p.linked, render: (p) => <LinkCell steamId={p.steamId} name={p.name} link={p.link} streamer={p.streamer} /> },
              { key: 'faction', width: '11%', label: '진영', sort: (p) => p.faction, render: (p) => <FactionChip name={p.faction} color={color(p.faction)} /> },
              { key: 'kills', width: '6%', label: '킬', num: true, sort: (p) => p.kills, render: (p) => p.kills },
              { key: 'deaths', width: '6%', label: '데스', num: true, sort: (p) => p.deaths, render: (p) => p.deaths },
              { key: 'kd', width: '6%', label: 'K/D', num: true, sort: (p) => p.kd, render: (p) => p.kd.toFixed(2) },
              { key: 'hs', width: '6%', label: 'HS%', num: true, sort: (p) => p.hs, render: (p) => <span className={(p.hs ?? 0) >= 60 ? 'warn-text' : undefined}>{p.hs == null ? '—' : `${p.hs}%`}</span> },
              { key: 'cash', width: '7%', label: '돈', num: true, sort: (p) => p.cash, render: (p) => (live?.cashUnreliable ? '—' : fmtNum(p.cash)) },
              { key: 'pingMs', width: '7%', label: '핑', num: true, sort: (p) => p.pingMs, render: (p) => <span className={`ping-${p.pingMs >= 200 ? 'bad' : p.pingMs >= 120 ? 'mid' : 'ok'}`}>{p.pingMs}ms</span> },
              { key: 'session', width: '9%', label: '접속', num: true, sort: (p) => p.session, render: (p) => fmtDuration(p.session) },
              { key: 'actions', width: '88px', label: <span className="sr-only">작업</span>, className: 'actions', render: (p) => <button className="btn btn-sm" type="button" onClick={() => openPlayer(p)}>관리</button> },
            ]} />
          )}
        </div>
      </div>
    </Card>
  );
}

function LinkCell({ steamId, name, link, streamer }: { steamId: string; name: string; link: Link | null; streamer: Streamer | null }) {
  const chzzk = link ? <PlayerName className="tag tag-chzzk" steamId={steamId} name={name}>{link.chzzkName || link.chzzkChannelId}</PlayerName> : null;
  if (streamer) return <div className="small"><span className="tag tag-streamer">화이트리스트</span>{chzzk ?? <PlayerName className="tag tag-discord" steamId={steamId} name={name}>{streamer.discordName ?? streamer.discordId}</PlayerName>}</div>;
  if (!link) return <span className="tag tag-danger">미연동</span>;
  return <div className="small">{chzzk}</div>;
}

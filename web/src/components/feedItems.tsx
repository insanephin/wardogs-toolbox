import { memo } from 'react';
import type { Engagement, FeedEvent, Kill } from '../lib/types.ts';
import { fmtTime, fmtClock, fmtDist, fmtAgo, pct, TAG_LABELS, describeEvent, killParts } from '../lib/format.ts';
import { Icon } from './iconButton.tsx';
import { faArrowRight } from '@fortawesome/free-solid-svg-icons';
import { useFactionColor, Fdot } from './common.tsx';
import { useStore } from '../lib/store.ts';
import { SortTable } from './sortTable.tsx';
import { PlayerName } from './playerName.tsx';

export function EventDetail({ e }: { e: FeedEvent }) {
  if ((e.type === 'player_joined' || e.type === 'player_left') && e.steamId) {
    return <>{e.type === 'player_joined' ? '입장' : '퇴장'}: <PlayerName steamId={e.steamId} name={e.playerName} /> (현재 {e.players}명)</>;
  }
  if (e.type !== 'killed') return <>{describeEvent(e)}</>;
  if (e.suicide) return <>자살: <PlayerName steamId={e.victimSteamId} name={e.victimName}>{e.victimName || e.victimSteamId || '?'}</PlayerName></>;
  const k = killParts(e);
  return <>킬: <PlayerName steamId={e.killerSteamId} name={e.killerName}>{k.killer}</PlayerName> <Icon icon={faArrowRight} className="inline-icon" aria-label="처치" /> <PlayerName steamId={e.victimSteamId} name={e.victimName}>{k.victim}</PlayerName>{k.extra}</>;
}

const SHOWN_TAGS = ['Headshot', 'Penetration', 'Ricochet', 'WeaponMelee', 'VehicleExplosion', 'RoadKill', 'Falling'];

function Who({ name, steamId, faction, className }: { name: string | null; steamId: string | null; faction: string | null; className?: string }) {
  const color = useFactionColor();
  return <span className="who"><Fdot color={color(faction)} /><PlayerName className={className} steamId={steamId} name={name}>{name || steamId || '환경'}</PlayerName></span>;
}

const MAX_BADGES = 2;

function KillLine({ k }: { k: Kill }) {
  const hasKiller = !!(k.killerSteamId || k.killerName);
  const weapon = k.suicide ? null : k.weapon || (hasKiller ? '?' : null);
  return (
    <span className="kill-main">
      {k.suicide ? <span className="muted">자살</span>
        : hasKiller ? <Who name={k.killerName} steamId={k.killerSteamId} faction={k.killerFaction} className="kill-name" />
        : <span className="muted" title="게임 서버가 킬러 정보를 보내지 않은 처치입니다">{k.weapon ? '알 수 없음' : '환경'}</span>}
      {weapon ? <span className="kill-weapon" title={weapon}>(<span>{weapon}</span>)</span> : null}
      <Icon icon={faArrowRight} className="kill-arrow" aria-label="처치" />
      <Who name={k.victimName} steamId={k.victimSteamId} faction={k.victimFaction} className="kill-name" />
    </span>
  );
}

function KillBadges({ k }: { k: Kill }) {
  const badges = [
    ...(k.teamkill ? [{ key: 'tk', label: '팀킬', cls: 'tag tag-danger', title: '폴링으로 본 진영 기준 추정' }] : []),
    ...k.tags.filter((t) => SHOWN_TAGS.includes(t)).map((t) => ({ key: t, label: TAG_LABELS[t] || t, cls: `tag${t === 'Headshot' ? ' tag-hs' : ''}`, title: undefined })),
  ];
  const rest = badges.slice(MAX_BADGES);
  return (
    <span className="kill-meta">
      {badges.slice(0, MAX_BADGES).map((b) => <span key={b.key} className={b.cls} title={b.title}>{b.label}</span>)}
      {rest.length ? <span className="tag" title={rest.map((b) => b.label).join(', ')}>{`+${rest.length}`}</span> : null}
    </span>
  );
}

export const KillRow = memo(function KillRow({ k, compact = false }: { k: Kill; compact?: boolean; now?: number }) {
  return (
    <div className={`kill${k.suicide ? ' kill-self' : ''}`}>
      <span className="kill-time" title={`매치 시계 ${fmtClock(k.eventTime)}`}>{compact ? fmtAgo(k.receivedAt) : fmtTime(k.receivedAt)}</span>
      <KillLine k={k} />
      <KillBadges k={k} />
      <span className="kill-dist">{k.distanceM != null ? fmtDist(k.distanceM) : '—'}</span>
    </div>
  );
});

export function KillTable({ rows, limit }: { rows: Kill[]; limit?: number }) {
  return (
    <SortTable rows={rows} rowKey={(k) => k.eventId} compact limit={limit} initial={{ key: 'at', dir: -1 }}
      rowClass={(k) => (k.suicide ? 'row-self' : undefined)} columns={[
        { key: 'at', width: '11%', label: '시간', desc: true, sort: (k) => k.receivedAt, className: 'kill-time', render: (k) => <span title={`매치 시계 ${fmtClock(k.eventTime)}`}>{fmtTime(k.receivedAt)}</span> },
        { key: 'kill', label: '킬', sort: (k) => (k.suicide ? null : k.killerName ?? k.killerSteamId), className: 'kill-cell', render: (k) => <KillLine k={k} /> },
        { key: 'tags', width: '9rem', label: '태그', desc: true, sort: (k) => Number(k.teamkill) * 2 + Number(k.headshot), className: 'kill-cell', render: (k) => <KillBadges k={k} /> },
        { key: 'dist', width: '10%', label: '거리', num: true, sort: (k) => k.distanceM, className: 'nowrap', render: (k) => (k.distanceM != null ? fmtDist(k.distanceM) : '—') },
      ]} />
  );
}

function EngBar({ factions }: { factions: Engagement['factions'] }) {
  const color = useFactionColor();
  const order = Object.keys(useStore((s) => s.colors));
  const rank = (f: string) => (order.includes(f) ? order.indexOf(f) : order.length);
  const rows = Object.entries(factions).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
  const total = rows.reduce((s, [, n]) => s + n, 0);
  return (
    <div className="eng-bar" aria-label="진영별 킬 비중">
      {rows.map(([f, n]) => (
        <span key={f} style={{ width: `${(n / total) * 100}%`, background: color(f) || 'var(--muted)' }} title={`${f}: ${n}킬`} />
      ))}
    </div>
  );
}

export function engagementMeta(g: Engagement) {
  const duration = g.startTime != null && g.endTime != null ? g.endTime - g.startTime : (g.endedAt - g.startedAt) / 1000;
  return `${fmtTime(g.startedAt)} · ${Math.max(1, Math.round(duration))}초${g.map ? ` · ${g.map}` : ''}`;
}

export function EngagementCard({ g, head = true }: { g: Engagement; head?: boolean }) {
  const topWeapons = Object.entries(g.weapons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ${n}`).join(', ');
  return (
    <div className="eng">
      {head ? (
        <div className="eng-head">
          <strong>교전 #{g.id}</strong>
          <span className="muted small">{engagementMeta(g)}</span>
        </div>
      ) : null}
      <EngBar factions={g.factions} />
      <div className="eng-stats">
        <span><b>{g.kills}</b> 킬</span>
        <span><b>{g.participants.length}</b> 명</span>
        <span>헤드샷 <b>{pct(g.headshots, g.kills) ?? 0}%</b></span>
        {g.avgDistance != null ? <span>평균 <b>{fmtDist(g.avgDistance)}</b></span> : null}
        {g.teamkills ? <span className="danger">팀킬 {g.teamkills}</span> : null}
      </div>
      {topWeapons ? <div className="muted small">{topWeapons}</div> : null}
    </div>
  );
}

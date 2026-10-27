import { memo } from 'react';
import type { Engagement, FeedEvent, Kill } from '../lib/types.ts';
import { fmtTime, fmtClock, fmtDist, fmtAgo, pct, TAG_LABELS, describeEvent, killParts } from '../lib/format.ts';
import { Icon } from './iconButton.tsx';
import { faArrowRight } from '@fortawesome/free-solid-svg-icons';
import { useFactionColor, Fdot } from './common.tsx';
import { SortTable } from './sortTable.tsx';

export function EventDetail({ e }: { e: FeedEvent }) {
  if (e.type !== 'killed' || e.suicide) return <>{describeEvent(e)}</>;
  const k = killParts(e);
  return <>킬: {k.killer} <Icon icon={faArrowRight} className="inline-icon" aria-label="처치" /> {k.victim}{k.extra}</>;
}

const SHOWN_TAGS = ['Headshot', 'Penetration', 'Ricochet', 'WeaponMelee', 'VehicleExplosion', 'RoadKill', 'Falling'];

function Who({ name, steamId, faction }: { name: string | null; steamId: string | null; faction: string | null }) {
  const color = useFactionColor();
  return <span className="who" title={steamId || ''}><Fdot color={color(faction)} />{name || steamId || '환경'}</span>;
}

export const KillRow = memo(function KillRow({ k, compact = false }: { k: Kill; compact?: boolean; now?: number }) {
  const tags = k.tags.filter((t) => SHOWN_TAGS.includes(t));
  return (
    <div className={`kill${k.teamkill ? ' kill-tk' : ''}${k.suicide ? ' kill-self' : ''}`}>
      <span className="kill-time" title={`매치 시계 ${fmtClock(k.eventTime)}`}>{compact ? fmtAgo(k.receivedAt) : fmtTime(k.receivedAt)}</span>
      <span className="kill-main">
        {k.killerSteamId && !k.suicide ? <Who name={k.killerName} steamId={k.killerSteamId} faction={k.killerFaction} /> : null}
        <span className="kill-weapon">{k.suicide ? '자살' : k.weapon || (k.killerSteamId ? '?' : '환경사')}</span>
        <Who name={k.victimName} steamId={k.victimSteamId} faction={k.victimFaction} />
      </span>
      <span className="kill-meta">
        {k.teamkill ? <span className="tag tag-danger" title="폴링으로 본 진영 기준 추정">팀킬</span> : null}
        {tags.map((t) => <span key={t} className={`tag${t === 'Headshot' ? ' tag-hs' : ''}`}>{TAG_LABELS[t] || t}</span>)}
        {k.distanceM != null ? <span className="kill-dist">{fmtDist(k.distanceM)}</span> : null}
      </span>
    </div>
  );
});

export function KillTable({ rows, limit }: { rows: Kill[]; limit?: number }) {
  return (
    <SortTable rows={rows} rowKey={(k) => k.eventId} compact limit={limit} initial={{ key: 'at', dir: -1 }}
      rowClass={(k) => (k.teamkill ? 'row-tk' : k.suicide ? 'row-self' : undefined)} columns={[
        { key: 'at', label: '시각', desc: true, sort: (k) => k.receivedAt, className: 'kill-time', render: (k) => <span title={`매치 시계 ${fmtClock(k.eventTime)}`}>{fmtTime(k.receivedAt)}</span> },
        { key: 'killer', label: '킬러', sort: (k) => (k.suicide ? null : k.killerName ?? k.killerSteamId), render: (k) => (
          k.killerSteamId && !k.suicide ? <Who name={k.killerName} steamId={k.killerSteamId} faction={k.killerFaction} /> : <span className="muted">—</span>
        ) },
        { key: 'weapon', label: '무기', sort: (k) => (k.suicide ? '자살' : k.weapon), className: 'kill-weapon', render: (k) => (k.suicide ? '자살' : k.weapon || (k.killerSteamId ? '?' : '환경사')) },
        { key: 'victim', label: '피해자', sort: (k) => k.victimName ?? k.victimSteamId, render: (k) => <Who name={k.victimName} steamId={k.victimSteamId} faction={k.victimFaction} /> },
        { key: 'tags', label: '태그', desc: true, sort: (k) => Number(k.teamkill) * 2 + Number(k.headshot), render: (k) => (
          <>
            {k.teamkill ? <span className="tag tag-danger" title="폴링으로 본 진영 기준 추정">팀킬</span> : null}
            {k.tags.filter((t) => SHOWN_TAGS.includes(t)).map((t) => <span key={t} className={`tag${t === 'Headshot' ? ' tag-hs' : ''}`}>{TAG_LABELS[t] || t}</span>)}
          </>
        ) },
        { key: 'dist', label: '거리', num: true, sort: (k) => k.distanceM, className: 'nowrap', render: (k) => (k.distanceM != null ? fmtDist(k.distanceM) : '—') },
      ]} />
  );
}

export function EngagementCard({ g }: { g: Engagement }) {
  const color = useFactionColor();
  const duration = g.startTime != null && g.endTime != null ? g.endTime - g.startTime : (g.endedAt - g.startedAt) / 1000;
  const factions = Object.entries(g.factions).sort((a, b) => b[1] - a[1]);
  const total = factions.reduce((s, [, n]) => s + n, 0);
  const topWeapons = Object.entries(g.weapons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} ${n}`).join(', ');
  return (
    <div className="eng">
      <div className="eng-head">
        <strong>교전 #{g.id}</strong>
        <span className="muted small">{`${fmtTime(g.startedAt)} · ${Math.max(1, Math.round(duration))}초 · ${g.map ?? ''}`}</span>
      </div>
      <div className="eng-bar" aria-label="진영별 킬 비중">
        {factions.map(([f, n]) => (
          <span key={f} style={{ width: `${(n / total) * 100}%`, background: color(f) || 'var(--muted)' }} title={`${f}: ${n}킬`} />
        ))}
      </div>
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

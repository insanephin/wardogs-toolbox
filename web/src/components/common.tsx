import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, ReactNode } from 'react';
import type { Action } from '../lib/types.ts';
import { useStore } from '../lib/store.ts';
import { api } from '../lib/api.ts';

export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function useFactionColor() {
  const colors = useStore((s) => s.colors);
  return (name: string | null | undefined) => (name ? colors[name] ?? null : null);
}

export function Card({ title, extra, className = '', children }: { title?: ReactNode; extra?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <section className={`card ${title ? '' : 'card-bare'} ${className}`.replace(/\s+/g, ' ').trim()}>
      {title ? <header className="card-head"><h2>{title}</h2><div className="card-extra">{extra}</div></header> : null}
      {children}
    </section>
  );
}

let actionSlot: HTMLElement | null = null;
const slotListeners = new Set<() => void>();
export const setPageActionSlot = (el: HTMLElement | null) => {
  actionSlot = el;
  slotListeners.forEach((fn) => fn());
};
const subscribeSlot = (fn: () => void) => (slotListeners.add(fn), () => slotListeners.delete(fn));

export function PageActions({ children }: { children: ReactNode }) {
  const slot = useSyncExternalStore(subscribeSlot, () => actionSlot);
  return slot ? createPortal(children, slot) : null;
}

export function FactionChip({ name, color }: { name: string | null | undefined; color: string | null | undefined }) {
  if (!name) return <span className="chip chip-muted">미배정</span>;
  return <span className="chip" style={{ '--c': color || 'var(--muted)' } as CSSProperties}>{name}</span>;
}

export function ScoreRow({ name, color, score, cap }: { name: string; color?: string | null; score: number; cap: number | null | undefined }) {
  return (
    <div className="score-row">
      <FactionChip name={name} color={color} />
      <div className="score-bar" role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={cap || 100} aria-label={`${name} 점수`}>
        <div className="score-fill" style={{ width: `${cap ? Math.min(100, (score / cap) * 100) : 0}%`, background: color ?? undefined }} />
      </div>
      <div className="score-num">{score}</div>
    </div>
  );
}

export function Fdot({ color }: { color: string | null | undefined }) {
  return <span className="fdot" style={{ background: color || 'var(--muted)' }} />;
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;

export function useOnAction(fn: (a: Action) => unknown): void {
  const latest = useStore((s) => s.lastAction);
  const seen = useRef(latest);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!latest || latest === seen.current) return;
    seen.current = latest;
    fnRef.current(latest);
  }, [latest]);
}

export function Avatar({ src }: { src: string | null | undefined }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) return <span className="avatar avatar-empty" aria-hidden="true" />;
  return <img className="avatar" src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

export type SteamProfiles = Record<string, { name: string; avatar: string }>;

export function useSteamProfiles(ids: string[]): SteamProfiles {
  const [profiles, setProfiles] = useState<SteamProfiles>({});
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    if (!key) return;
    let stale = false;
    const list = key.split(',');
    const chunks: string[][] = [];
    for (let i = 0; i < list.length; i += 200) chunks.push(list.slice(i, i + 200));
    Promise.all(chunks.map((c) => api<SteamProfiles>('GET', `/api/steam/profiles?ids=${c.join(',')}`)))
      .then((parts) => !stale && setProfiles(Object.assign({}, ...parts)), () => {});
    return () => {
      stale = true;
    };
  }, [key]);
  return profiles;
}

export function MapArt({ map, lighting, variant }: { map: string | null | undefined; lighting?: string | null; variant: 'square' | 'wide' | '720' }) {
  const src = map ? `/api/map-art?${new URLSearchParams({ map, lighting: lighting || 'DayClear', variant })}` : null;
  const [broken, setBroken] = useState<string | null>(null);
  if (!src || broken === src) return null;
  return <img className={`map-art map-art-${variant}`} src={src} alt="" onError={() => setBroken(src)} />;
}

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Action } from '../lib/types.ts';
import { useStore } from '../lib/store.ts';

// Re-renders every `ms` so "N초 전" labels stay fresh between events.
export function useNow(ms = 5000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useFactionColor() {
  const colors = useStore((s) => s.colors);
  return (name: string | null | undefined) => (name ? colors[name] ?? null : null);
}

export function Card({ title, extra, className = '', children }: { title: ReactNode; extra?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <section className={`card ${className}`.trim()}>
      <header className="card-head"><h2>{title}</h2>{extra}</header>
      {children}
    </section>
  );
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

// Runs `fn` whenever a new dashboard action arrives over the stream (not for ones seen before mount).
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

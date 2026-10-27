import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { CashHistory } from '../lib/types.ts';
import { useStore, setState } from '../lib/store.ts';
import { api } from '../lib/api.ts';
import { fmtNum } from '../lib/format.ts';
import { Card, Empty, Fdot, useFactionColor } from './common.tsx';

const HEIGHT = 220;
const M = { top: 12, right: 16, bottom: 24, left: 56 };

const money = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${+(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${+(n / 1e3).toFixed(1)}k`;
  return `$${Math.round(n)}`;
};
const clock = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / step) * step;
}

export function CashCard() {
  const history = useStore((s) => s.cash);
  const unreliable = useStore((s) => s.live?.cashUnreliable);
  const order = useStore((s) => s.live?.status?.factionScores);
  const [view, setView] = useState<'chart' | 'table'>('chart');

  useEffect(() => {
    api<CashHistory>('GET', '/api/cash-history').then((cash) => setState({ cash }), () => {});
  }, []);

  const points = history?.points || [];
  const known = (order || []).map((f) => f.name);
  const factions = [...new Set([...known, ...points.flatMap((p) => Object.keys(p.factions))])].filter((n) => points.some((p) => n in p.factions));

  return (
    <Card title="진영별 소지금 추이" extra={
      <div className="seg" role="radiogroup" aria-label="보기 방식">
        <button type="button" role="radio" aria-checked={view === 'chart'} className={view === 'chart' ? 'on' : ''} onClick={() => setView('chart')}>그래프</button>
        <button type="button" role="radio" aria-checked={view === 'table'} className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>표</button>
      </div>
    }>
      <div className="card-body">
        {unreliable ? <Empty>이 호스트는 돈을 0으로 보고합니다.</Empty>
          : !points.length ? <Empty>기록이 없습니다.</Empty>
            : view === 'chart' ? <Chart points={points} factions={factions} /> : <Table points={points} factions={factions} />}
      </div>
    </Card>
  );
}

function Chart({ points, factions }: { points: CashHistory['points']; factions: string[] }) {
  const color = useFactionColor();
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const max = niceMax(Math.max(...points.flatMap((p) => factions.map((f) => p.factions[f] ?? 0))));
  const innerW = width - M.left - M.right;
  const innerH = HEIGHT - M.top - M.bottom;
  const x = (t: number) => M.left + (t1 === t0 ? innerW / 2 : ((t - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => M.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  const xTicks = t1 === t0 ? [t0] : [t0, t0 + (t1 - t0) / 2, t1];
  const last = points[points.length - 1]!;

  const nearest = (clientX: number) => {
    const rect = wrap.current!.getBoundingClientRect();
    const px = clientX - rect.left;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(x(points[i]!.t) - px) < Math.abs(x(points[best]!.t) - px)) best = i;
    return best;
  };
  const onMove = (e: PointerEvent) => setHover(nearest(e.clientX));
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setHover((h) => Math.min(points.length - 1, Math.max(0, (h ?? points.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1))));
  };

  const hp = hover != null ? points[hover] : null;
  const tipLeft = hp ? Math.min(x(hp.t) + 12, width - 180) : 0;

  return (
    <>
      <div className="chart-legend">
        {factions.map((f) => (
          <span key={f} className="chart-key"><span className="chart-swatch" style={{ background: color(f) ?? 'var(--muted)' }} />{f}<b>{money(last.factions[f] ?? 0)}</b></span>
        ))}
        <span className="chart-key muted">합계<b>{money(last.total)}</b></span>
      </div>
      <div className="chart-wrap" ref={wrap}>
        <svg width={width} height={HEIGHT} role="img" aria-label={`진영별 소지금 추이, ${points.length}개 표본. 좌우 화살표로 시점 이동`} tabIndex={0}
          onPointerMove={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onFocus={() => setHover(points.length - 1)} onBlur={() => setHover(null)}>
          {ticks.map((v) => (
            <g key={v}>
              <line className="chart-grid" x1={M.left} x2={width - M.right} y1={y(v)} y2={y(v)} />
              <text className="chart-axis" x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end">{money(v)}</text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={t} className="chart-axis" x={x(t)} y={HEIGHT - 6} textAnchor={xTicks.length === 1 ? 'middle' : i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>{clock(t)}</text>
          ))}
          {factions.map((f) => {
            const pts = points.filter((p) => f in p.factions);
            const c = color(f) ?? 'var(--muted)';
            return pts.length > 1
              ? <polyline key={f} className="chart-line" stroke={c} points={pts.map((p) => `${x(p.t)},${y(p.factions[f]!)}`).join(' ')} />
              : <circle key={f} className="chart-dot" fill={c} cx={x(pts[0]!.t)} cy={y(pts[0]!.factions[f]!)} r={4} />;
          })}
          {hp ? (
            <g>
              <line className="chart-crosshair" x1={x(hp.t)} x2={x(hp.t)} y1={M.top} y2={M.top + innerH} />
              {factions.filter((f) => f in hp.factions).map((f) => (
                <circle key={f} className="chart-dot" fill={color(f) ?? 'var(--muted)'} cx={x(hp.t)} cy={y(hp.factions[f]!)} r={4} />
              ))}
            </g>
          ) : null}
        </svg>
        {hp ? (
          <div className="chart-tip" style={{ left: tipLeft }} role="status">
            <div className="muted">{clock(hp.t)}</div>
            {factions.filter((f) => f in hp.factions).map((f) => (
              <div key={f} className="chart-tip-row"><b>{money(hp.factions[f]!)}</b><span><span className="chart-tip-key" style={{ background: color(f) ?? 'var(--muted)' }} />{f}</span></div>
            ))}
            <div className="chart-tip-row"><b>{money(hp.total)}</b><span className="muted">합계</span></div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function Table({ points, factions }: { points: CashHistory['points']; factions: string[] }) {
  const color = useFactionColor();
  return (
    <div className="table-wrap chart-table">
      <table className="table table-compact">
        <thead><tr><th>시각</th>{factions.map((f) => <th key={f} className="num"><Fdot color={color(f)} />{f}</th>)}<th className="num">합계</th></tr></thead>
        <tbody>
          {[...points].reverse().map((p) => (
            <tr key={p.t}>
              <td>{clock(p.t)}</td>
              {factions.map((f) => <td key={f} className="num">{p.factions[f] == null ? '—' : `$${fmtNum(p.factions[f])}`}</td>)}
              <td className="num">{`$${fmtNum(p.total)}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

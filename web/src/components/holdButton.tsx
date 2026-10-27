import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

const HOLD_MS = 1500;

export function HoldButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [progress, setProgress] = useState(0);
  const start = useRef<number | null>(null);
  const frame = useRef(0);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const tick = () => {
    if (start.current == null) return;
    const p = Math.min((performance.now() - start.current) / HOLD_MS, 1);
    setProgress(p);
    if (p < 1) {
      frame.current = requestAnimationFrame(tick);
      return;
    }
    start.current = null;
    setProgress(0);
    confirmRef.current();
  };

  const begin = () => {
    if (start.current != null) return;
    start.current = performance.now();
    frame.current = requestAnimationFrame(tick);
  };

  const end = () => {
    start.current = null;
    cancelAnimationFrame(frame.current);
    setProgress(0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (!e.repeat) begin();
  };

  const seconds = HOLD_MS / 1000;
  return (
    <button type="button" className="btn btn-danger-outline hold-btn"
      aria-label={`${label}: ${seconds}초간 누르고 있기`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        begin();
      }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onBlur={end}
      onKeyDown={onKeyDown} onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && end()}
      onContextMenu={(e) => e.preventDefault()}>
      <span className="hold-fill" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
      <span className="hold-text">{progress > 0 ? '계속 누르세요' : `${label} · ${seconds}초 누르기`}</span>
    </button>
  );
}

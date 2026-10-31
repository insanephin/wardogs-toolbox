import type { ReactNode } from 'react';
import { openPlayerById } from './playerDialog.tsx';

export function PlayerName({ steamId, name, className, children }: { steamId: string | null | undefined; name: string | null | undefined; className?: string; children?: ReactNode }) {
  const label = children ?? (name || steamId);
  if (!steamId) return <span className={className}>{label}</span>;
  return (
    <button type="button" className={`player-link${className ? ` ${className}` : ''}`} title={`${steamId} · 플레이어 정보`}
      onClick={(e) => {
        e.stopPropagation();
        openPlayerById(steamId, { name });
      }}>{label}</button>
  );
}

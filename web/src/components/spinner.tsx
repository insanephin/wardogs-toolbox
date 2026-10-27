export function Spinner({ size = 20, scan = false }: { size?: number; scan?: boolean }) {
  const big = size >= 48;
  return (
    <svg className={scan ? 'radar radar-scan' : 'radar'} width={size} height={size} viewBox="0 0 40 40" role="status" aria-label="불러오는 중">
      <circle className="radar-ring" cx="20" cy="20" r="18" />
      {big ? <circle className="radar-ring radar-ring-in" cx="20" cy="20" r="11" /> : null}
      {big ? <circle className="radar-blip" cx="28" cy="12" r="1.5" /> : null}
      {big ? <circle className="radar-blip" cx="13" cy="26" r="1.5" style={{ animationDelay: '1.4s' }} /> : null}
      <g className="radar-sweep">
        <path className="radar-trail" d="M20 20 L20 2 A18 18 0 0 0 7.27 7.27 Z" />
        <line className="radar-arm" x1="20" y1="20" x2="20" y2="2" />
      </g>
    </svg>
  );
}

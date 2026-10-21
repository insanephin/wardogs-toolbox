import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { followLink } from '../lib/publicRouter.ts';

export const PAGES = [
  { id: 'link', path: '/', label: '계정 등록' },
  { id: 'report', path: '/report', label: '신고하기' },
] as const;

export type PageId = (typeof PAGES)[number]['id'];

function AutoHeight({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const el = inner.current!;
    const observer = new ResizeObserver(() => setHeight(el.offsetHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="public-viewport" style={{ height }}>
      <div ref={inner} className="public-viewport-inner">{children}</div>
    </div>
  );
}

export function PublicShell({ current, children }: { current: PageId; children: ReactNode }) {
  const index = PAGES.findIndex((p) => p.id === current);
  const title = PAGES[index]?.label;
  return (
    <div className="public-wrap">
      <main className="card public-card">
        <nav className="public-nav" aria-label="메뉴" style={{ '--i': index } as CSSProperties}>
          <span className="public-nav-thumb" aria-hidden="true" />
          {PAGES.map(({ id, path, label }) => (
            <a key={id} href={path} onClick={followLink} className={id === current ? 'on' : undefined} aria-current={id === current ? 'page' : undefined}>{label}</a>
          ))}
        </nav>
        <h1>{title}</h1>
        <AutoHeight>{children}</AutoHeight>
      </main>
      <footer className="public-footer">
        <nav aria-label="정책">
          <a href="/terms">이용약관</a>
          <a href="/privacy" className="strong">개인정보처리방침</a>
        </nav>
        <p>© 2026 insanephin</p>
      </footer>
    </div>
  );
}

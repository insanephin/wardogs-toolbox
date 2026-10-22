import type { ReactNode } from 'react';

export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="public-wrap">
      <main className="card public-card">{children}</main>
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

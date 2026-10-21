import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PAGES, PublicShell } from './components/publicNav.tsx';
import type { PageId } from './components/publicNav.tsx';
import { usePath } from './lib/publicRouter.ts';
import LinkPage from './views/LinkPage.tsx';
import ReportPage from './views/ReportPage.tsx';
import './app.css';

function PublicApp() {
  const path = usePath();
  const page = PAGES.find((p) => p.path === path) ?? PAGES[0];
  const [visited, setVisited] = useState<ReadonlySet<PageId>>(() => new Set([page.id]));

  useEffect(() => {
    document.title = page.label;
    setVisited((v) => (v.has(page.id) ? v : new Set(v).add(page.id)));
  }, [page]);

  return (
    <PublicShell current={page.id}>
      {PAGES.map(({ id }) => (visited.has(id) || id === page.id ? (
        <section key={id} className="public-page" hidden={id !== page.id}>
          {id === 'link' ? <LinkPage active={id === page.id} /> : <ReportPage active={id === page.id} />}
        </section>
      ) : null))}
    </PublicShell>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><PublicApp /></StrictMode>);

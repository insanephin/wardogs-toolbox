import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { PublicShell } from './components/publicNav.tsx';
import { IconButton } from './components/iconButton.tsx';
import { Overlay } from './lib/modal.tsx';
import { followLink, leave, usePath } from './lib/publicRouter.ts';
import LinkPage from './views/LinkPage.tsx';
import ReportPage from './views/ReportPage.tsx';
import Landing from './views/Landing.tsx';
import './app.css';

function parse(path: string): { code: string | null; reporting: boolean } {
  const parts = path.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const reporting = parts[parts.length - 1] === 'report';
  if (reporting) parts.pop();
  return { code: parts[0] ?? null, reporting };
}

const TITLE = 'Wardogs RCON 패널';

function PublicApp() {
  const { code, reporting } = parse(usePath());
  const home = code ? `/${encodeURIComponent(code)}` : '/';
  const closeReport = () => leave(home);
  const [serverName, setServerName] = useState<string | null>(null);
  const [discordResult] = useState(() => new URLSearchParams(location.search).get('p') === 'discord');
  const landing = !code && !discordResult;

  useEffect(() => {
    if (location.search) history.replaceState(null, '', location.pathname);
  }, []);
  useEffect(() => {
    document.title = reporting ? '신고' : landing ? TITLE : serverName ? `${serverName} · 계정 등록` : '계정 등록';
  }, [reporting, serverName, landing]);

  const report = reporting ? (
    <Overlay label="신고" onClose={closeReport}>
      <div className="modal-head-center">
        <h2>신고</h2>
        <IconButton icon={faXmark} label="닫기" className="btn-ghost" onClick={closeReport} />
      </div>
      <ReportPage code={code} />
    </Overlay>
  ) : null;

  if (landing) return <><Landing />{report}</>;
  return (
    <PublicShell>
      <h1>{serverName ?? '계정 등록'}</h1>
      <LinkPage code={code} onServer={setServerName} />
      {discordResult ? null : <a className="btn btn-block" href={`${code ? home : ''}/report`} onClick={followLink}>신고하기</a>}
      {report}
    </PublicShell>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><PublicApp /></StrictMode>);

import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { faXmark } from '@fortawesome/free-solid-svg-icons';
import { PublicShell } from './components/publicNav.tsx';
import { IconButton } from './components/iconButton.tsx';
import { Overlay } from './lib/modal.tsx';
import { followLink, leave, usePath } from './lib/publicRouter.ts';
import LinkPage from './views/LinkPage.tsx';
import ReportPage from './views/ReportPage.tsx';
import './app.css';

function PublicApp() {
  const reporting = usePath() === '/report';
  const closeReport = () => leave('/');

  useEffect(() => {
    if (location.search) history.replaceState(null, '', location.pathname);
  }, []);
  useEffect(() => {
    document.title = reporting ? '신고' : '계정 등록';
  }, [reporting]);

  return (
    <PublicShell>
      <h1>계정 등록</h1>
      <LinkPage />
      <a className="btn btn-block" href="/report" onClick={followLink}>신고하기</a>
      {reporting ? (
        <Overlay label="신고" onClose={closeReport}>
          <div className="modal-head-center">
            <h2>신고</h2>
            <IconButton icon={faXmark} label="닫기" className="btn-ghost" onClick={closeReport} />
          </div>
          <ReportPage />
        </Overlay>
      ) : null}
    </PublicShell>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><PublicApp /></StrictMode>);

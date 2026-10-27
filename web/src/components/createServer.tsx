import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { openDialog, Overlay } from '../lib/modal.tsx';
import { api, errorMessage, refreshMe } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { Spinner } from './spinner.tsx';

export const openCreateServer = () => openDialog((close) => <CreateServerDialog onClose={close} />);

function CreateServerDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    urlRef.current?.focus();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const s = await api<{ id: number; name: string }>('POST', '/api/servers', { url: url.trim(), password });
      onClose();
      toast(`${s.name} 연결을 확인하고 추가했습니다`);
      await refreshMe(s.id);
      location.hash = '#server';
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Overlay label="새 서버 추가" onClose={() => !busy && onClose()}>
      <h2>새 서버 추가</h2>
      <form className="modal-form" onSubmit={submit} autoComplete="off">
        {error ? <p className="banner banner-error" role="alert">{error}</p> : null}
        <label className="field">
          <span className="field-label">RCON 주소</span>
          <input ref={urlRef} required maxLength={300} spellCheck={false} placeholder="http://203.0.113.10:7776" value={url} disabled={busy}
            onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">RCON 비밀번호</span>
          <input type="password" autoComplete="new-password" required maxLength={200} value={password} disabled={busy}
            onChange={(e) => setPassword(e.target.value)} />
          <span className="hint">게임 서버 ini의 Password 또는 Saved/RCON/ADMIN-PASSWORD.txt 값</span>
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>취소</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !url.trim() || !password}>
            {busy ? <><Spinner scan /> 연결 확인 중</> : '연결 확인 후 추가'}
          </button>
        </div>
      </form>
    </Overlay>
  );
}

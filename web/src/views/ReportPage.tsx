import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { fmtTime, charCount } from '../lib/format.ts';
import { call } from '../lib/publicApi.ts';
import { Spinner } from '../components/spinner.tsx';
import { Icon } from '../components/iconButton.tsx';
import { faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons';

interface MyReport {
  id: number;
  createdAt: number;
  targetName: string;
  status: string;
  serverName: string | null;
}

interface ReportState {
  configured: boolean;
  reporter: string | null;
  mine: MyReport[];
  servers: { id: number; name: string }[];
  online: Record<number, string[]>;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: '접수됨', cls: 'muted' },
  resolved: { label: '처리 완료', cls: 'ok-text' },
  rejected: { label: '반려', cls: 'muted' },
};
const MAX_DESCRIPTION = 1000;

function signInError(r: string | null): string {
  if (!r || r === 'linked' || r === 'proven') return '';
  if (r === 'cancelled') return '로그인이 취소되었습니다.';
  if (r === 'expired') return '로그인이 만료되었습니다. 다시 시도해주세요.';
  if (r === 'unconfigured') return '이 로그인은 아직 설정되지 않았습니다. 관리자에게 문의해주세요.';
  return '계정을 확인하지 못했습니다. 다시 시도해주세요.';
}

export default function ReportPage({ code }: { code: string | null }) {
  const [st, setSt] = useState<ReportState | null>(null);
  const [error, setError] = useState(() => signInError(new URLSearchParams(location.search).get('r')));
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [description, setDescription] = useState('');
  const [showMine, setShowMine] = useState(false);
  const [server, setServer] = useState<number | null>(null);

  useEffect(() => {
    call<ReportState>('GET', `/api/report/me${code ? `?${new URLSearchParams({ server: code })}` : ''}`).then((r) => {
      setSt(r);
      if (r.servers.length === 1) setServer(r.servers[0]!.id);
    }, (e) => setError(e.message));
  }, []);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setBusy(true);
    setError('');
    setDone(false);
    try {
      const r = await call<{ mine: MyReport[] }>('POST', '/api/report', {
        server,
        code,
        targetName: fd.get('targetName'),
        description,
      });
      setSt((s) => (s ? { ...s, mine: r.mine } : s));
      form.reset();
      setDescription('');
      setDone(true);
    } catch (ex) {
      setError((ex as Error).message);
    }
    setBusy(false);
  };

  return (
    <>
      <div className="public-intro">
        <p className="public-lead">문제를 일으킨 플레이어의 닉네임과 사유를 적어주세요.</p>
        <p className="public-lead small">허위 신고는 제재될 수 있습니다.</p>
      </div>

      {done ? <div className="banner banner-ok" role="status">신고가 접수되었습니다. 관리자가 확인합니다.</div> : null}
      {error ? <div className="banner banner-error" role="alert">{error}</div> : null}

      {!st ? <p className="empty"><Spinner /></p> : !st.reporter ? (
        <div className="stack">
          <p className="public-lead">신고하려면 먼저 치지직으로 로그인하세요.</p>
          {st.configured
            ? <a className="btn btn-primary btn-block" href={`/auth/chzzk?${new URLSearchParams({ next: 'report', ...(code && { s: code }) })}`}>치지직으로 로그인</a>
            : <p className="muted small">로그인이 아직 설정되지 않았습니다.</p>}
        </div>
      ) : (
        <>
          <p className="small"><span className="muted">신고자:</span> {st.reporter}</p>
          {!st.servers.length ? <p className="muted small">지금 신고를 받는 서버가 없습니다.</p> : null}
          <form className="stack report-form" onSubmit={onSubmit}>
            {st.servers.length > 1 ? (
              <label className="field">
                <span className="field-label">서버</span>
                <select required value={server ?? ''} onChange={(e) => setServer(Number(e.target.value) || null)}>
                  <option value="" disabled>신고할 서버를 고르세요</option>
                  {st.servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            ) : null}
            <label className="field">
              <span className="field-label">닉네임</span>
              <input name="targetName" list="online-players" maxLength={64} required autoComplete="off" placeholder="신고할 플레이어의 게임 닉네임" />
              <datalist id="online-players">{(server != null ? st.online[server] ?? [] : []).map((n) => <option key={n} value={n} />)}</datalist>
            </label>
            <label className="field">
              <span className="field-label"><span>사유</span><span>{`${charCount(description)}/${MAX_DESCRIPTION}`}</span></span>
              <textarea name="description" className="small" rows={5} required value={description} onChange={(e) => setDescription(e.target.value)}
                placeholder="언제, 어느 맵에서, 무슨 일이 있었는지 적어주세요" />
            </label>
            <button className="btn btn-primary btn-block" type="submit" disabled={busy || server == null || charCount(description) > MAX_DESCRIPTION}>신고 접수</button>
          </form>

          {st.mine.length ? (
            <section className="stack">
              <button className="btn btn-ghost btn-block" type="button" aria-expanded={showMine} aria-controls="my-reports" onClick={() => setShowMine((v) => !v)}>
                {`내 신고 ${st.mine.length}건`}
                <Icon icon={showMine ? faChevronUp : faChevronDown} />
              </button>
              {showMine ? (
                <ul id="my-reports" className="plain-list">
                  {st.mine.map((r) => (
                    <li key={r.id} className="row-between small">
                      <span>{r.targetName} <span className="muted">{st.servers.length > 1 && r.serverName ? `${r.serverName} · ` : ''}{fmtTime(r.createdAt)}</span></span>
                      <span className={STATUS[r.status]?.cls}>{STATUS[r.status]?.label ?? r.status}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </>
  );
}

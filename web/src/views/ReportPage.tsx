import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { fmtTime, charCount } from '../lib/format.ts';
import { call } from '../lib/publicApi.ts';
import { prepareImage } from '../lib/image.ts';
import { Spinner } from '../components/spinner.tsx';
import { Icon } from '../components/iconButton.tsx';
import { faChevronDown, faChevronUp } from '@fortawesome/free-solid-svg-icons';

interface MyReport {
  id: number;
  createdAt: number;
  targetName: string;
  status: string;
  serverName: string | null;
  images: number[];
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
const MAX_IMAGES = 3;

async function uploadImage(reportId: number, blob: Blob): Promise<void> {
  const res = await fetch(`/api/report/${reportId}/images`, {
    method: 'POST', body: blob, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'wardogs-dashboard', 'Content-Type': blob.type },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error?.message || `업로드 실패 (${res.status})`);
}

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
  const [images, setImages] = useState<{ file: File; url: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const addImages = (list: FileList | null) => {
    const picked = [...(list ?? [])].filter((f) => /^image\/(jpeg|png|webp)$/.test(f.type));
    setImages((cur) => [...cur, ...picked.map((file) => ({ file, url: URL.createObjectURL(file) }))].slice(0, MAX_IMAGES));
    if (fileRef.current) fileRef.current.value = '';
  };
  const removeImage = (i: number) => setImages((cur) => {
    URL.revokeObjectURL(cur[i]!.url);
    return cur.filter((_, j) => j !== i);
  });

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
      const r = await call<{ id: number; mine: MyReport[] }>('POST', '/api/report', {
        server,
        code,
        targetName: fd.get('targetName'),
        description,
      });
      const failed: string[] = [];
      for (const img of images) {
        try {
          await uploadImage(r.id, await prepareImage(img.file));
        } catch (ex) {
          failed.push((ex as Error).message);
        }
      }
      const mine = images.length ? (await call<ReportState>('GET', `/api/report/me${code ? `?${new URLSearchParams({ server: code })}` : ''}`).catch(() => null))?.mine ?? r.mine : r.mine;
      setSt((s) => (s ? { ...s, mine } : s));
      form.reset();
      setDescription('');
      images.forEach((img) => URL.revokeObjectURL(img.url));
      setImages([]);
      setDone(true);
      if (failed.length) setError(`신고는 접수되었지만 이미지 ${failed.length}장을 올리지 못했습니다: ${[...new Set(failed)].join(' / ')}`);
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
          <p className="public-lead">신고하려면 먼저 스팀으로 로그인하세요.</p>
          {st.configured
            ? <a className="btn btn-primary btn-block" href={`/auth/steam?${new URLSearchParams({ next: 'report', ...(code && { s: code }) })}`}>스팀으로 로그인</a>
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
            <div className="field">
              <span className="field-label"><span>이미지 (선택)</span><span>{`${images.length}/${MAX_IMAGES}`}</span></span>
              {images.length ? (
                <div className="thumbs">
                  {images.map((img, i) => (
                    <div key={img.url} className="thumb-wrap">
                      <img className="thumb" src={img.url} alt={`첨부 이미지 ${i + 1}`} />
                      <button type="button" className="thumb-remove" aria-label={`이미지 ${i + 1} 빼기`} onClick={() => removeImage(i)}>×</button>
                    </div>
                  ))}
                </div>
              ) : null}
              {images.length < MAX_IMAGES ? (
                <label className="btn btn-block">
                  이미지 추가
                  <input ref={fileRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => addImages(e.target.files)} />
                </label>
              ) : null}
              <span className="hint">JPG·PNG·WebP, 최대 {MAX_IMAGES}장. 관리자와 본인만 볼 수 있습니다.</span>
            </div>
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
                    <li key={r.id} className="stack small">
                      <div className="row-between">
                        <span>{r.targetName} <span className="muted">{st.servers.length > 1 && r.serverName ? `${r.serverName} · ` : ''}{fmtTime(r.createdAt)}</span></span>
                        <span className={STATUS[r.status]?.cls}>{STATUS[r.status]?.label ?? r.status}</span>
                      </div>
                      {r.images?.length ? (
                        <div className="thumbs">
                          {r.images.map((id) => (
                            <a key={id} href={`/api/report/images/${id}`} target="_blank" rel="noopener noreferrer">
                              <img className="thumb" src={`/api/report/images/${id}`} alt="첨부 이미지" loading="lazy" />
                            </a>
                          ))}
                        </div>
                      ) : null}
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

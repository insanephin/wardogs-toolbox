import { useEffect, useState } from 'react';
import { api, errorMessage } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { toast } from '../lib/toast.ts';
import { fmtTime } from '../lib/format.ts';
import { Card, Empty } from '../components/common.tsx';
import { Spinner } from '../components/spinner.tsx';
import type { Account as AccountState, IdentityProvider } from '../lib/types.ts';
import { PROVIDER_LABEL } from '../lib/labels.ts';

const PROVIDERS: IdentityProvider[] = ['discord', 'chzzk', 'twitch'];

function resultText(code: string, provider: string): { ok: boolean; text: string } {
  const who = PROVIDER_LABEL[provider] ?? '';
  switch (code) {
    case 'linked': return { ok: true, text: `${who} 계정을 연결했습니다.` };
    case 'taken': return { ok: false, text: `이 ${who} 계정은 이미 다른 스팀 계정에 연결되어 있습니다.` };
    case 'cancelled': return { ok: false, text: `${who} 로그인을 취소했습니다.` };
    case 'expired': return { ok: false, text: '패널 로그인이 만료되었습니다. 다시 로그인한 뒤 연결하세요.' };
    case 'unconfigured': return { ok: false, text: `서버에 ${who} 로그인 설정이 없습니다.` };
    default: return { ok: false, text: `${who} 계정을 확인하지 못했습니다. 다시 시도해주세요.` };
  }
}

export default function Account() {
  const [st, setSt] = useState<AccountState | null>(null);
  const [error, setError] = useState('');
  const [notice] = useState(() => {
    const q = new URLSearchParams(location.search);
    const code = q.get('identity');
    return code ? resultText(code, q.get('p') ?? '') : null;
  });

  useEffect(() => {
    if (location.search) history.replaceState(null, '', `/panel${location.hash}`);
    api<AccountState>('GET', '/api/account').then(setSt, (err) => setError(errorMessage(err)));
  }, []);

  const unlink = async (p: IdentityProvider) => {
    if (!(await confirmAction('연결 해제', `${PROVIDER_LABEL[p]} 계정으로는 더 이상 로그인할 수 없습니다. 스팀 로그인은 그대로입니다.`, { confirm: '해제' }))) return;
    try {
      const r = await api<Pick<AccountState, 'identities' | 'providers'>>('DELETE', `/api/account/identities/${p}`);
      setSt((s) => (s ? { ...s, ...r } : s));
      toast('연결을 해제했습니다');
    } catch (err) {
      toast(`연결 해제 실패: ${errorMessage(err)}`, 'error');
    }
  };

  return (
    <Card>
      <div className="card-body stack">
        {notice ? <div className={`banner ${notice.ok ? 'banner-ok' : 'banner-error'}`} role="status">{notice.text}</div> : null}
        {error ? <Empty>불러오지 못했습니다: {error}</Empty> : !st ? <Spinner /> : (
          <>
            <dl className="kv">
              <dt>스팀</dt>
              <dd>{st.name} <span className="mono muted small">{st.steamId}</span></dd>
            </dl>
            <ul className="plain-list">
              {PROVIDERS.map((p) => {
                const linked = st.identities.find((i) => i.provider === p);
                return (
                  <li key={p} className="row-between">
                    <span>
                      <b>{PROVIDER_LABEL[p]}</b>{' '}
                      {linked ? <span className="small">{linked.name ?? linked.providerId} <span className="muted">{fmtTime(linked.linkedAt)}</span></span>
                        : <span className="muted small">연결 안 됨</span>}
                    </span>
                    {linked ? <button className="btn btn-sm btn-danger-outline" type="button" onClick={() => unlink(p)}>해제</button>
                      : st.providers[p] ? <a className="btn btn-sm" href={`/panel/link/${p}`}>연결</a>
                      : <span className="muted small">설정 안 됨</span>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}

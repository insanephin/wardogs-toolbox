import { useEffect, useState } from 'react';
import { fmtTime } from '../lib/format.ts';
import { call } from '../lib/publicApi.ts';
import { followLink } from '../lib/publicRouter.ts';
import type { Link } from '../lib/types.ts';
import { Spinner } from '../components/spinner.tsx';

type Provider = 'chzzk' | 'steam';
interface LinkState {
  configured: Record<Provider, boolean>;
  chzzk: string | null;
  steam: string | null;
  link: Link | null;
  joinUrl: string | null;
}

const STEPS: { id: Provider; label: string }[] = [
  { id: 'chzzk', label: '치지직' },
  { id: 'steam', label: '스팀' },
];

function discordResultText(r: string, via: string): { ok: boolean; text: string } {
  const who = STEPS.find((s) => s.id === via)?.label ?? '';
  switch (r) {
    case 'proven': return { ok: true, text: `${who} 로그인을 확인했습니다. 디스코드로 돌아가 남은 로그인을 진행해주세요.` };
    case 'reserved': return { ok: true, text: '스트리머 인증을 완료했습니다. 서버 접속 우선권이 적용되었습니다.' };
    case 'queued': return { ok: true, text: '스트리머 인증을 완료했습니다. 게임 서버에 연결되는 대로 접속 우선권이 적용됩니다.' };
    case 'taken': return { ok: false, text: `이 ${who} 계정은 이미 다른 계정과 연동되어 있습니다. 디스코드로 돌아가 확인해주세요.` };
    case 'cancelled': return { ok: false, text: `${who} 로그인이 취소되었습니다. 디스코드의 버튼을 다시 눌러주세요.` };
    case 'expired': return { ok: false, text: '링크가 만료되었습니다. 디스코드에서 다시 인증을 시작해주세요.' };
    case 'unconfigured': return { ok: false, text: '스트리머 인증이 아직 설정되지 않았습니다. 관리자에게 문의해주세요.' };
    default: return { ok: false, text: `${who} 계정을 확인하지 못했습니다. 디스코드의 버튼을 다시 눌러주세요.` };
  }
}

function resultText(r: string, p: string, via: string): { ok: boolean; text: string } | null {
  if (p === 'discord') return discordResultText(r, via);
  const who = STEPS.find((s) => s.id === p)?.label ?? '';
  switch (r) {
    case 'linked': return { ok: true, text: '연동을 완료했습니다.' };
    case 'proven': return null;
    case 'taken': return { ok: false, text: `이 ${who} 계정은 이미 다른 계정과 연동되어 있어 바꿀 수 없습니다.` };
    case 'cancelled': return { ok: false, text: `${who} 로그인이 취소되었습니다.` };
    case 'expired': return { ok: false, text: '로그인이 만료되었습니다. 다시 시도해주세요.' };
    case 'unconfigured': return { ok: false, text: `${who} 연동이 아직 설정되지 않았습니다. 관리자에게 문의해주세요.` };
    default: return { ok: false, text: `${who} 계정을 확인하지 못했습니다. 다시 시도해주세요.` };
  }
}

export default function LinkPage() {
  const [st, setSt] = useState<LinkState | null>(null);
  const [error, setError] = useState('');
  const [notice] = useState(() => {
    const q = new URLSearchParams(location.search);
    return q.get('r') && location.pathname === '/' ? resultText(q.get('r')!, q.get('p') ?? '', q.get('via') ?? '') : null;
  });
  const [fromDiscord] = useState(() => new URLSearchParams(location.search).get('p') === 'discord');

  useEffect(() => {
    call<LinkState>('GET', '/api/link/me').then(setSt, (e) => setError(e.message));
  }, []);

  const link = st?.link;
  if (fromDiscord && notice) {
    return (
      <>
        <div className={`banner ${notice.ok ? 'banner-ok' : 'banner-error'}`} role="status">{notice.text}</div>
        <p className="public-lead small">이 창은 닫아도 됩니다. 진행 상황은 디스코드 메시지에서 확인할 수 있습니다.</p>
      </>
    );
  }
  const shown = (p: Provider) => st?.[p] ?? (p === 'chzzk' ? link?.chzzkName : link?.steamName) ?? null;

  return (
    <>
      {notice ? <div className={`banner ${notice.ok ? 'banner-ok' : 'banner-error'}`} role="status">{notice.text}</div> : null}
      {error ? <div className="banner banner-error" role="alert">{error}</div> : null}

      <div className="notice-box">
        <strong>로그인 전 확인하세요</strong>
        <ul>
          <li>이 페이지는 <b>일반 시청자용</b>입니다. 스트리머는 디스코드에서 치지직·스팀 연동(스트리머 인증)을 진행하세요.</li>
          <li>스팀은 <b>워독스를 보유한 계정</b>으로 로그인하세요.</li>
          <li>한 번 등록하면 <b>직접 해제하거나 다른 계정으로 바꿀 수 없습니다.</b></li>
          <li>게임이 없는 계정에 잘못 등록한 경우처럼 특수한 경우에만, <a href="/report" onClick={followLink}>신고하기</a>로 본인 닉네임과 사유를 적어 요청하면 관리자가 확인 후 해제합니다.</li>
        </ul>
      </div>

      {!st ? <p className="empty"><Spinner /></p> : (
        <>
          <ol className="link-steps">
            {STEPS.map(({ id, label }, i) => {
              const name = shown(id);
              return (
                <li key={id} className="link-step">
                  <span className="link-step-label">{`${i + 1}. ${label}`}</span>
                  <span className="link-step-name muted small" title={name ?? undefined}>{name ?? '로그인 필요'}</span>
                  {!st.configured[id] ? <span className="link-step-status muted small">준비 중</span>
                    : link ? <span className="link-step-status ok-text small">연동됨</span>
                    : st[id] ? <span className="link-step-status ok-text small">확인됨</span>
                      : <a className="btn btn-sm btn-block btn-primary" href={`/auth/${id}`}>로그인</a>}
                </li>
              );
            })}
          </ol>
          {link ? (
            <>
              <p className="public-lead small">{`${fmtTime(link.linkedAt)}에 등록되었습니다.`}</p>
              {st.joinUrl ? (
                <a className="btn btn-block btn-primary" href={st.joinUrl} target="_blank" rel="noopener noreferrer">서버 접속</a>
              ) : <p className="public-lead small">지금은 서버에 접속할 수 없습니다.</p>}
            </>
          ) : st.chzzk || st.steam ? (
            <p className="public-lead small">{`${st.chzzk ? '스팀' : '치지직'}에도 로그인하면 연동이 완료됩니다.`}</p>
          ) : null}
        </>
      )}
    </>
  );
}

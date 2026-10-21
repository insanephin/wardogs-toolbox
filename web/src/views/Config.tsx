import { useEffect, useRef, useState } from 'react';
import type { ConfigDoc, ConfigResult } from '../lib/types.ts';
import { api, errorMessage, ApiError } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { toast } from '../lib/toast.ts';
import { Card, Empty } from '../components/common.tsx';

type Panel = { warnings: unknown[]; result?: undefined } | { result: ConfigResult; applied: boolean };

const OUTCOME_LABELS: Record<string, string> = { applied: '즉시 적용', 'next-match': '다음 매치', 'next-restart': '다음 재시작', pending: '확인 중' };

export default function Config() {
  const [doc, setDoc] = useState<ConfigDoc | null>(null);
  const [text, setText] = useState('');
  const [validatedText, setValidatedText] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ConfigResult | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [busy, setBusy] = useState(false);

  const dirty = !!doc && text !== doc.text;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  useEffect(() => () => {
    if (dirtyRef.current) toast('저장하지 않은 설정 수정 내용이 버려졌습니다', 'warn');
  }, []);

  const load = async () => {
    if (dirty && !(await confirmAction('수정 내용 버리기', '편집기의 수정 내용이 사라집니다.', { confirm: '다시 불러오기' }))) return;
    let d: ConfigDoc;
    try {
      d = await api<ConfigDoc>('GET', '/api/config');
    } catch (err) {
      return toast(`설정 문서를 불러오지 못했습니다: ${errorMessage(err)}`, 'error');
    }
    setDoc(d);
    setText(d.text || '');
    setValidatedText(null);
    setLastResult(null);
    setPanel({ warnings: d.warnings });
  };

  useEffect(() => {
    load();
  }, []);

  const validate = async () => {
    setBusy(true);
    try {
      const r = await api<ConfigResult>('POST', '/api/config/validate', { text });
      setLastResult(r);
      setValidatedText(text);
      setPanel({ result: r, applied: false });
    } catch (err) {
      toast(`검증 실패: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const removed = (lastResult?.changed || []).filter((c) => c.removed);
    const warn = removed.length ? ` 삭제될 섹션이 있습니다: ${removed.map((c) => c.section).join(', ')}.` : '';
    if (!(await confirmAction('설정 적용', `서버 설정 문서 전체를 교체합니다.${warn}`, { confirm: '적용' }))) return;
    if (!doc) return;
    setBusy(true);
    try {
      const r = await api<ConfigResult>('PUT', '/api/config', { text, revision: doc.revision });
      setPanel({ result: r, applied: true });
      toast('설정을 적용했습니다');
      const d = await api<ConfigDoc>('GET', '/api/config');
      setDoc(d);
      setText(d.text);
      setValidatedText(null);
      setLastResult(null);
    } catch (err) {
      if (err instanceof ApiError && err.result) setPanel({ result: err.result as ConfigResult, applied: false });
      toast(`적용 실패: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const canApply = !busy && doc && doc.writable !== false && text === validatedText && lastResult?.ok;
  const meta = doc ? `리비전 ${doc.revision}${dirty ? ' · 수정됨' : ''}${doc.writable === false ? ' · 읽기 전용' : ''}` : '';

  return (
    <>
      <div className="banner banner-warn">
        적용은 문서 전체를 교체합니다. 지운 섹션은 서버에서도 삭제됩니다. 손대지 않은 값도 다시 검증되므로 오래된 값 하나가 전체 적용을 막을 수 있습니다. 항상 불러온 문서를 고쳐서 검증 후 적용하세요.
      </div>
      <div className="grid-main">
        <Card title="ServerSettings.ini" extra={<span className="muted small">{meta}</span>}>
          <div className="toolbar">
            <button className="btn" type="button" onClick={load}>불러오기</button>
            <button className="btn" type="button" disabled={busy} onClick={validate}>검증 (드라이런)</button>
            <button className="btn btn-danger" type="button" disabled={!canApply} onClick={apply}>적용</button>
          </div>
          <div className="card-body">
            <textarea className="code-editor" spellCheck={false} aria-label="ServerSettings.ini" wrap="off" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        </Card>
        <div className="stack">
          <Card title="검증·적용 결과"><div className="card-body"><div className="stack"><ResultPanel panel={panel} /></div></div></Card>
          <Card title="참고">
            <div className="card-body small stack">
              <p>ScorePeriod는 18~30초, 다음 매치부터 적용. MaxPlayers는 즉시, RCON 섹션은 다음 재시작 때 적용됩니다.</p>
              <p>배열 키의 !Key=ClearArray는 "기존 배열 비우기" 명령이지 항목이 아닙니다.</p>
              <p>Season 2의 이벤트 피드 키(bEventFeedEnabled, EventFeedEndpoints, EventFeedServerName)는 RCON으로 쓸 수 없어 적용 시 조용히 빠집니다. 호스트 파일에 직접 넣고 재시작하세요.</p>
              <Locked doc={doc} />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function Locked({ doc }: { doc: ConfigDoc | null }) {
  const locked: string[] = [];
  for (const s of doc?.sections || []) {
    for (const k of s.keyOverrides || []) if (k.writable === false) locked.push(`${s.section} · ${k.key}${k.lockedBy ? ` (${k.lockedBy})` : ''}`);
  }
  if (!locked.length) return null;
  return (
    <div>
      <p className="strong">고정된 키 (명령줄 인자로 잠김, 바꿔도 적용 안 됨):</p>
      <ul className="plain-list mono">{locked.map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  );
}

function List({ title, items, cls }: { title: string; items: unknown[] | undefined; cls?: string }) {
  if (!items?.length) return null;
  return (
    <div>
      <h3 className={cls}>{title}</h3>
      <ul className="plain-list small">{items.map((x, i) => <li key={i}>{typeof x === 'string' ? x : JSON.stringify(x)}</li>)}</ul>
    </div>
  );
}

function ResultPanel({ panel }: { panel: Panel | null }) {
  if (!panel) return null;
  if (!panel.result) {
    return panel.warnings?.length ? <List title="경고" items={panel.warnings} /> : <Empty>검증을 실행하면 결과가 여기 표시됩니다.</Empty>;
  }
  const { result: r, applied } = panel;
  const removed = (r.changed || []).filter((c) => c.removed);
  return (
    <>
      <div className={`banner banner-${r.ok ? 'ok' : 'error'}`}>
        {r.ok
          ? (applied ? `적용됨. 새 리비전 ${r.revision}` : '문제없이 적용할 수 있습니다.')
          : r.status === 412 ? '다른 관리자가 먼저 수정했습니다. 다시 불러와서 수정 내용을 옮기세요.' : '서버가 값을 거부했습니다. 아무것도 적용되지 않았습니다.'}
      </div>
      {r.errors?.length ? (
        <div>
          <h3 className="danger">거부된 값</h3>
          <ul className="plain-list small">
            {r.errors.map((e, i) => <li key={i}><span className="mono">{`[${e.section}] ${e.key}`}</span>{` ${e.message || e.code}`}</li>)}
          </ul>
        </div>
      ) : null}
      {removed.length ? <div className="banner banner-error">삭제될 섹션: {removed.map((c) => c.section).join(', ')}</div> : null}
      <List title="바뀌는 섹션" items={(r.changed || []).filter((c) => !c.removed).map((c) => `${c.section}${c.added ? ' (추가)' : ''}${c.keys?.length ? `: ${c.keys.join(', ')}` : ''}`)} />
      <List title="적용 결과" items={(r.outcomes || []).map((o) => `${o.section}: ${OUTCOME_LABELS[o.state] ?? o.state}${o.detail ? ` · ${o.detail}` : ''}`)} />
      <List title="상위 설정에 가려진 키" items={r.shadowed} />
      <List title="이 빌드가 모르는 키 (제거됨)" items={r.stripped} />
      <List title="경고" items={r.warnings} />
    </>
  );
}

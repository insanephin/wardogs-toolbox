import { useEffect, useMemo, useRef, useState } from 'react';
import { INI_HELP, FILE_HELP, scanIni, entryAt } from '../lib/iniHelp.ts';
import type { IniEntry } from '../lib/iniHelp.ts';
import type { ConfigDoc, ConfigResult } from '../lib/types.ts';
import { api, errorMessage, ApiError } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { toast } from '../lib/toast.ts';
import { OUTCOME_LABEL } from '../lib/labels.ts';
import { Card, Empty } from '../components/common.tsx';

const eolOf = (t: string) => (t.includes('\r\n') ? '\r\n' : '\n');
const toEditor = (t: string) => t.replace(/\r\n/g, '\n');
const toFile = (t: string, eol: string) => (eol === '\n' ? t : t.replace(/\r?\n/g, eol));

type Panel = { warnings: unknown[]; result?: undefined } | { result: ConfigResult; applied: boolean };

export default function Config() {
  const [doc, setDoc] = useState<ConfigDoc | null>(null);
  const [text, setText] = useState('');
  const [validatedText, setValidatedText] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ConfigResult | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [busy, setBusy] = useState(false);
  const [cursorLine, setCursorLine] = useState(0);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const trackCursor = () => {
    const ta = editorRef.current;
    if (ta) setCursorLine(ta.value.slice(0, ta.selectionStart).split('\n').length - 1);
  };
  const jumpTo = (line: number) => {
    const ta = editorRef.current;
    if (!ta) return;
    const at = ta.value.split('\n').slice(0, line).reduce((n, l) => n + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(at, at);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
    ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 3);
    setCursorLine(line);
  };

  const eol = doc ? eolOf(doc.text) : '\n';
  const dirty = !!doc && text !== toEditor(doc.text);
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
    setText(toEditor(d.text || ''));
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
      const r = await api<ConfigResult>('POST', '/api/config/validate', { text: toFile(text, eol) });
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
      const r = await api<ConfigResult>('PUT', '/api/config', { text: toFile(text, eol), revision: doc.revision });
      setPanel({ result: r, applied: true });
      toast('설정을 적용했습니다');
      const d = await api<ConfigDoc>('GET', '/api/config');
      setDoc(d);
      setText(toEditor(d.text));
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
      <div className="banner banner-warn">적용 시 문서 전체를 교체합니다. 지운 섹션은 서버에서도 삭제됩니다.</div>
      <div className="grid-main">
        <Card title="ServerSettings.ini" extra={<span className="muted small">{meta}</span>}>
          <div className="toolbar">
            <button className="btn" type="button" onClick={load}>불러오기</button>
            <button className="btn" type="button" disabled={busy} onClick={validate}>검증 (드라이런)</button>
            <button className="btn btn-danger" type="button" disabled={!canApply} onClick={apply}>적용</button>
            <button className="btn" type="button" disabled={!text} onClick={() => download(toFile(text, eol))}>.ini 다운로드</button>
          </div>
          <div className="card-body">
            <textarea ref={editorRef} className="code-editor" spellCheck={false} aria-label="ServerSettings.ini" wrap="off" value={text}
              onChange={(e) => { setText(e.target.value); trackCursor(); }} onSelect={trackCursor} onKeyUp={trackCursor} onClick={trackCursor} />
          </div>
        </Card>
        <div className="stack">
          <IniHelpCard text={text} sections={doc?.sections ?? []} cursorLine={cursorLine} onJump={jumpTo} />
          <Card title="검증·적용 결과"><div className="card-body"><div className="stack"><ResultPanel panel={panel} /></div></div></Card>
          <Locked doc={doc} />
        </div>
      </div>
    </>
  );
}

type SectionMeta = ConfigDoc['sections'][number];

interface HelpGroup {
  section: string;
  line: number;
  keys: { key: string; line: number; count: number; commented: boolean }[];
}

function groupEntries(entries: IniEntry[]): HelpGroup[] {
  const groups: HelpGroup[] = [];
  for (const e of entries) {
    if (e.key === null) {
      groups.push({ section: e.section!, line: e.line, keys: [] });
      continue;
    }
    const g = groups.at(-1);
    if (!g) continue;
    const same = g.keys.find((k) => k.key === e.key && k.commented === e.commented);
    if (same) same.count++;
    else g.keys.push({ key: e.key, line: e.line, count: 1, commented: e.commented });
  }
  return groups;
}

function IniHelpCard({ text, sections, cursorLine, onJump }: { text: string; sections: SectionMeta[]; cursorLine: number; onJump: (line: number) => void }) {
  const entries = useMemo(() => scanIni(text), [text]);
  const groups = useMemo(() => groupEntries(entries), [entries]);
  const at = entryAt(entries, cursorLine);
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => activeRef.current?.scrollIntoView({ block: 'nearest' }), [at?.section, at?.key]);

  const applies = (section: string, key?: string) => {
    const s = sections.find((x) => x.section === section);
    const o = key ? s?.keyOverrides?.find((k) => k.key?.toLowerCase() === key.toLowerCase()) : undefined;
    const state = o?.appliesWhen ?? s?.appliesWhen;
    return state ? <span className="tag">{OUTCOME_LABEL[state] ?? state}</span> : null;
  };

  return (
    <Card title="항목 설명">
      <div className="card-body ini-help">
        <p className="hint">{FILE_HELP}</p>
        {!groups.length ? <Empty>섹션이 없습니다.</Empty> : groups.map((g) => {
          const sh = INI_HELP[g.section];
          const sectionActive = at?.section === g.section && at.key === null;
          return (
            <div key={`${g.section}@${g.line}`} className="ini-help-section">
              <button ref={sectionActive ? activeRef : undefined} type="button" className={`ini-help-item ini-help-head${sectionActive ? ' on' : ''}`} onClick={() => onJump(g.line)}>
                <span className="ini-help-title"><strong>{sh?.label ?? '설명 없는 섹션'}</strong>{applies(g.section)}</span>
                <span className="mono muted small">{`[${g.section}]`}</span>
                {sh?.text ? <span className="small">{sh.text}</span> : null}
              </button>
              {g.keys.map((k) => {
                const kh = sh?.keys[k.key];
                const active = at?.section === g.section && at.key === k.key && entries.some((e) => e.line === cursorLine && e.commented === k.commented);
                return (
                  <button key={`${k.key}${k.commented ? '#' : ''}`} ref={active ? activeRef : undefined} type="button" className={`ini-help-item${active ? ' on' : ''}${k.commented ? ' muted' : ''}`} onClick={() => onJump(k.line)}>
                    <span className="ini-help-title">
                      <strong>{kh?.label ?? k.key}</strong>
                      {k.commented ? <span className="tag">주석 처리됨</span> : null}
                      {k.count > 1 ? <span className="tag">{`${k.count}줄`}</span> : null}
                      {k.commented ? null : applies(g.section, k.key)}
                    </span>
                    <span className="mono muted small">{k.key}</span>
                    <span className="small">{kh?.text ?? '이 대시보드에 설명이 없는 키입니다. 서버 허용 목록에 없으면 적용 때 지워집니다.'}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ServerSettings.ini';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Locked({ doc }: { doc: ConfigDoc | null }) {
  const locked: string[] = [];
  for (const s of doc?.sections || []) {
    for (const k of s.keyOverrides || []) if (k.writable === false) locked.push(`${s.section} · ${k.key}${k.lockedBy ? ` (${k.lockedBy})` : ''}`);
  }
  if (!locked.length) return null;
  return (
    <Card title="고정된 키">
      <div className="card-body small"><ul className="plain-list mono">{locked.map((l) => <li key={l}>{l}</li>)}</ul></div>
    </Card>
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
    return panel.warnings?.length ? <List title="경고" items={panel.warnings} /> : <Empty>검증 결과가 없습니다.</Empty>;
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
      <List title="적용 결과" items={(r.outcomes || []).map((o) => `${o.section}: ${OUTCOME_LABEL[o.state] ?? o.state}${o.detail ? ` · ${o.detail}` : ''}`)} />
      <List title="상위 설정에 가려진 키" items={r.shadowed} />
      <List title="이 빌드가 모르는 키 (제거됨)" items={r.stripped} />
      <List title="경고" items={r.warnings} />
    </>
  );
}

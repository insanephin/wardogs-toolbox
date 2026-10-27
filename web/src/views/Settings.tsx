import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { ConfigPreset, ConfigResult, SettingField, SettingsDoc, SettingValue } from '../lib/types.ts';
import { api, run, errorMessage, ApiError } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { toast } from '../lib/toast.ts';
import { fmtTime } from '../lib/format.ts';
import { Card, PageActions, Empty } from '../components/common.tsx';
import { Spinner } from '../components/spinner.tsx';

type Draft = Record<string, string | boolean>;

const OUTCOME_LABELS: Record<string, string> = { applied: '즉시 적용', 'next-match': '다음 매치', 'next-restart': '서버 재시작 후', pending: '적용 시 확인' };

function toDraft(fields: SettingField[], values: Record<string, SettingValue | null>): Draft {
  const out: Draft = {};
  for (const f of fields) {
    const v = values[f.key];
    out[f.key] = f.type === 'bool' ? (v == null ? f.def === true : v === true) : v == null ? '' : String(v);
  }
  return out;
}

function fromDraft(f: SettingField, v: string | boolean): SettingValue {
  return f.type === 'number' ? (v === '' ? '' : Number(v)) : v;
}

export default function Settings() {
  const [doc, setDoc] = useState<SettingsDoc | { error: string } | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ r: ConfigResult; keys: string[] } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const load = async () => {
    try {
      const d = await api<SettingsDoc>('GET', '/api/settings');
      setDoc(d);
      setDraft(toDraft(d.fields, d.values));
      setErrors({});
    } catch (err) {
      setDoc({ error: errorMessage(err) });
    }
  };
  useEffect(() => {
    load();
  }, []);

  if (!doc) return <Empty><Spinner /></Empty>;
  if ('error' in doc) return <Empty>설정을 불러오지 못했습니다: {doc.error}</Empty>;

  const base = toDraft(doc.fields, doc.values);
  const shadows = new Map((result?.r.shadowed || []).map((x) => [`${x.section}|${String(x.key).toLowerCase()}`, x]));
  const changed = doc.fields.filter((f) => draft[f.key] !== base[f.key]);
  const set = (key: string, v: string | boolean) => setDraft((d) => ({ ...d, [key]: v }));

  const apply = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed.length) return;
    if (!(await confirmAction('설정 적용', `${changed.map((f) => f.label).join(', ')}을(를) 바꿉니다.`, { confirm: '적용' }))) return;
    setBusy(true);
    const values = Object.fromEntries(changed.map((f) => [f.key, fromDraft(f, draft[f.key]!)]));
    try {
      const r = await api<ConfigResult & { message?: string }>('PUT', '/api/settings', { revision: doc.revision, values });
      setResult({ r, keys: changed.map((f) => f.key) });
      toast(r.message ? `설정 적용: ${r.message}` : '설정을 적용했습니다');
      await load();
    } catch (err) {
      const r = err instanceof ApiError ? (err.result as ConfigResult | undefined) : undefined;
      if (r) {
        setResult({ r, keys: changed.map((f) => f.key) });
        const byIni: Record<string, string> = {};
        for (const x of r.errors || []) {
          const f = doc.fields.find((y) => y.ini === x.key && (!x.section || y.section === x.section));
          if (f) byIni[f.key] = x.message || x.code || '거부됨';
        }
        setErrors(byIni);
      }
      toast(`설정 적용 실패: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid-main">
      <Card>
        <PageActions><span className="muted small">{`리비전 ${doc.revision}${doc.writable ? '' : ' · 읽기 전용'}`}</span></PageActions>
        <form className="card-body stack" onSubmit={apply}>
          <div className="settings-grid">
            {doc.fields.map((f) => (
              <FieldInput key={f.key} f={f} value={draft[f.key]!} saved={doc.values[f.key]} dirty={draft[f.key] !== base[f.key]}
                locked={doc.locked[f.key]} applies={doc.applies?.[f.key]} shadow={shadows.get(`${f.section}|${f.ini.toLowerCase()}`)}
                error={errors[f.key]} disabled={!doc.writable || busy} onChange={(v) => set(f.key, v)} />
            ))}
          </div>
          <div className="row-between divider">
            <span className="muted small">{changed.length ? `바뀐 항목 ${changed.length}개` : '바뀐 항목이 없습니다'}</span>
            <span className="row-wrap">
              <button className="btn" type="button" disabled={busy || !changed.length} onClick={() => setDraft(base)}>되돌리기</button>
              <button className="btn btn-primary" type="submit" disabled={busy || !doc.writable || !changed.length}>적용</button>
            </span>
          </div>
        </form>
      </Card>
      <div className="stack">
        <Card title="프리셋"><Presets doc={doc} draft={draft} onLoad={(values) => setDraft((d) => ({ ...d, ...toDraft(doc.fields.filter((f) => f.key in values), values) }))}
          onSaved={(presets) => setDoc({ ...doc, presets })} /></Card>
        <Card title="적용 결과"><div className="card-body stack"><Result doc={doc} result={result} /></div></Card>
      </div>
    </div>
  );
}

function FieldInput({ f, value, saved, dirty, locked, applies, shadow, error, disabled, onChange }: {
  f: SettingField; value: string | boolean; saved: SettingValue | null | undefined; dirty: boolean;
  locked?: string; applies?: { state: string; description: string | null }; shadow?: { effective?: string };
  error?: string; disabled: boolean; onChange: (v: string | boolean) => void;
}) {
  const range = f.type !== 'number' ? '' : f.min != null && f.max != null ? `범위 ${f.min}~${f.max}` : f.min != null ? `${f.min} 이상` : '';
  const meta = [
    saved == null ? `기본값 ${f.type === 'bool' ? (f.def ? '켬' : '끔') : f.def === '' ? '없음' : f.def}` : null,
    range || null,
    f.hint,
  ].filter(Boolean).join(' · ');
  return (
    <label className="field">
      <span className="field-label">
        <span>{f.label}</span>
        <span>
          {dirty ? <span className="tag tag-hs">적용 전</span> : null}
          {locked ? <span className="tag tag-danger" title={`${locked}로 고정되어 바꿔도 적용되지 않습니다`}>고정</span>
            : shadow ? <span className="tag tag-danger" title={`저장은 됐지만 다른 곳의 설정이 우선해 실제 값은 "${shadow.effective ?? '?'}"입니다`}>가려짐</span>
              : applies ? <span className="tag" title={applies.description ?? undefined}>{OUTCOME_LABELS[applies.state] ?? applies.state}</span> : null}
        </span>
      </span>
      {f.type === 'bool' ? (
        <span className="seg" role="radiogroup" aria-label={f.label}>
          <button type="button" role="radio" aria-checked={value === true} className={value === true ? 'on' : ''} disabled={disabled} onClick={() => onChange(true)}>켬</button>
          <button type="button" role="radio" aria-checked={value === false} className={value === false ? 'on' : ''} disabled={disabled} onClick={() => onChange(false)}>끔</button>
        </span>
      ) : f.type === 'enum' ? (
        <select value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {value === '' ? <option value="">{`기본값 (${f.options!.find((o) => o.value === f.def)?.label ?? f.def})`}</option> : null}
          {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input type={f.type === 'number' ? 'number' : 'text'} value={String(value)} disabled={disabled} min={f.min} max={f.max} maxLength={f.maxLength}
          placeholder={f.def === '' ? '' : String(f.def)} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      )}
      {error ? <span className="hint danger">{error}</span> : meta ? <span className="hint">{meta}</span> : null}
    </label>
  );
}

function Presets({ doc, draft, onLoad, onSaved }: {
  doc: SettingsDoc; draft: Draft; onLoad: (values: Record<string, SettingValue>) => void; onSaved: (list: ConfigPreset[]) => void;
}) {
  const [picked, setPicked] = useState('');
  const [name, setName] = useState('');
  const preset = doc.presets.find((p) => p.name === picked);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    if (doc.presets.some((p) => p.name === n) && !(await confirmAction('프리셋 덮어쓰기', `${n} 프리셋을 지금 입력값으로 바꿉니다.`, { confirm: '덮어쓰기' }))) return;
    const values = Object.fromEntries(doc.fields.filter((f) => !f.secret && draft[f.key] !== '').map((f) => [f.key, fromDraft(f, draft[f.key]!)]));
    const list = await run('프리셋 저장', 'PUT', `/api/settings/presets/${encodeURIComponent(n)}`, { values });
    if (list) {
      onSaved(list as unknown as ConfigPreset[]);
      setPicked(n);
      setName('');
    }
  };
  const remove = async () => {
    if (!preset || !(await confirmAction('프리셋 삭제', `${preset.name} 프리셋을 지웁니다.`, { confirm: '삭제' }))) return;
    const list = await run('프리셋 삭제', 'DELETE', `/api/settings/presets/${encodeURIComponent(preset.name)}`);
    if (list) {
      onSaved(list as unknown as ConfigPreset[]);
      setPicked('');
    }
  };

  return (
    <div className="card-body stack">
      <div className="inline-field">
        <select aria-label="프리셋" value={picked} onChange={(e) => setPicked(e.target.value)}>
          <option value="">{doc.presets.length ? '프리셋 고르기' : '저장된 프리셋 없음'}</option>
          {doc.presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
        <button className="btn" type="button" disabled={!preset} onClick={() => preset && onLoad(preset.values)}>불러오기</button>
        <button className="btn btn-danger-outline" type="button" disabled={!preset} onClick={remove}>삭제</button>
      </div>
      {preset ? <p className="hint">{`${preset.savedBy} · ${fmtTime(preset.savedAt)} · ${Object.keys(preset.values).length}개 항목`}</p> : null}
      <form className="inline-field" onSubmit={save}>
        <input placeholder="새 프리셋 이름" aria-label="새 프리셋 이름" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn" type="submit" disabled={!name.trim()}>지금 입력값 저장</button>
      </form>
    </div>
  );
}

function Result({ doc, result }: { doc: SettingsDoc; result: { r: ConfigResult; keys: string[] } | null }) {
  if (!result) return <Empty>적용 내역이 없습니다.</Empty>;
  const { r, keys } = result;
  const labelsIn = (section: string) => doc.fields.filter((f) => f.section === section && keys.includes(f.key)).map((f) => f.label);
  return (
    <>
      <div className={`banner banner-${r.ok ? 'ok' : 'error'}`}>
        {r.ok ? '적용했습니다.' : r.status === 412 ? '다른 관리자가 먼저 수정했습니다. 다시 불러와서 입력하세요.' : '서버가 값을 거부했습니다. 아무것도 적용되지 않았습니다.'}
      </div>
      {r.outcomes?.length ? (
        <ul className="plain-list small">
          {r.outcomes.map((o, i) => {
            const labels = labelsIn(o.section);
            return <li key={i}><span className="tag">{OUTCOME_LABELS[o.state] ?? o.state}</span>{labels.length ? labels.join(', ') : o.section}{o.detail ? ` · ${o.detail}` : ''}</li>;
          })}
        </ul>
      ) : null}
      {r.shadowed?.length ? (
        <ul className="plain-list small">{r.shadowed.map((x, i) => {
          const f = doc.fields.find((y) => y.section === x.section && y.ini.toLowerCase() === String(x.key).toLowerCase());
          return <li key={i} className="danger">{`${f?.label ?? x.key}: 다른 설정이 우선해 실제 값은 "${x.effective ?? '?'}"입니다.`}</li>;
        })}</ul>
      ) : null}
      {r.errors?.length ? (
        <ul className="plain-list small">{r.errors.map((e, i) => <li key={i} className="danger">{`${e.key ?? ''} ${e.message || e.code || ''}`.trim()}</li>)}</ul>
      ) : null}
    </>
  );
}

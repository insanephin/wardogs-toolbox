import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent, FormEvent, HTMLAttributes, ReactNode } from 'react';
import { charCount } from './format.ts';

interface Dialog {
  id: number;
  render: () => ReactNode;
}

let dialogs: Dialog[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = (next: Dialog[]) => {
  dialogs = next;
  for (const l of listeners) l();
};

export function openDialog(render: (close: () => void) => ReactNode): () => void {
  const id = ++seq;
  const close = () => emit(dialogs.filter((d) => d.id !== id));
  emit([...dialogs, { id, render: () => render(close) }]);
  return close;
}

export function ModalHost() {
  const list = useSyncExternalStore((fn) => (listeners.add(fn), () => listeners.delete(fn)), () => dialogs);
  return list.map((d, i) => <IsTop.Provider key={d.id} value={i === list.length - 1}>{d.render()}</IsTop.Provider>);
}

const IsTop = createContext(true);

export function Overlay({ label, wide = false, onClose, children }: { label: string; wide?: boolean; onClose: () => void; children: ReactNode }) {
  const top = useContext(IsTop);
  const topRef = useRef(top);
  topRef.current = top;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && topRef.current && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

interface Field {
  name: string;
  label?: string;
  type?: 'text' | 'textarea' | 'select' | 'checkbox';
  value?: string | boolean;
  options?: { value: string; label: string }[];
  max?: number;
  required?: boolean;
  rows?: number;
  placeholder?: string;
  hint?: string;
  inputmode?: HTMLAttributes<HTMLInputElement>['inputMode'];
}

type FormValues = Record<string, string | boolean>;

interface ModalOptions {
  title: string;
  body?: ReactNode;
  fields?: Field[];
  confirm?: string;
  danger?: boolean;
  wide?: boolean;
}

export function modal(opts: ModalOptions): Promise<FormValues | null> {
  return new Promise((resolve) => {
    openDialog((close) => (
      <FormModal {...opts} onDone={(v) => {
        close();
        resolve(v);
      }} />
    ));
  });
}

export const confirmAction = (title: string, message: ReactNode, { danger = true, confirm = '실행' } = {}): Promise<boolean> =>
  modal({ title, body: <p>{message}</p>, confirm, danger }).then((v) => v !== null);

function initial(f: Field): string | boolean {
  if (f.type === 'checkbox') return !!f.value;
  if (f.type === 'select') return f.value ?? f.options?.[0]?.value ?? '';
  return f.value ?? '';
}

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function FormModal({ title, body = null, fields = [], confirm = '확인', danger = false, wide = false, onDone }: ModalOptions & { onDone: (v: FormValues | null) => void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.map((f) => [f.name, initial(f)])));
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const refs = useRef<Record<string, Control | null>>({});
  const submitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    (refs.current[fields[0]?.name ?? ''] || submitRef.current)?.focus();
  }, []);

  const set = (name: string, v: string | boolean) => setValues((s) => ({ ...s, [name]: v }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const out: FormValues = {};
    for (const f of fields) {
      const v = f.type === 'checkbox' ? values[f.name]! : String(values[f.name]).trim();
      out[f.name] = v;
      if ((f.required && !v) || (f.max && typeof v === 'string' && charCount(v) > f.max)) {
        if (f.required && !v) setInvalid((s) => ({ ...s, [f.name]: true }));
        refs.current[f.name]?.focus();
        return;
      }
    }
    onDone(out);
  };

  const cancel = () => onDone(null);

  return (
    <Overlay label={title} wide={wide} onClose={cancel}>
      <h2>{title}</h2>
      <div className="modal-body">{body}</div>
      <form className="modal-form" noValidate onSubmit={onSubmit}>
        {fields.map((f) => {
          const common = {
            name: f.name,
            ref: (el: Control | null) => {
              refs.current[f.name] = el;
            },
            className: invalid[f.name] ? 'invalid' : undefined,
          };
          if (f.type === 'checkbox') {
            return (
              <label key={f.name} className="check">
                <input type="checkbox" {...common} checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
                <span>{f.label}</span>
              </label>
            );
          }
          const value = String(values[f.name] ?? '');
          let input;
          const onChange = (e: ChangeEvent<Control>) => set(f.name, e.target.value);
          if (f.type === 'textarea') {
            input = <textarea {...common} rows={f.rows || 3} maxLength={f.max} placeholder={f.placeholder || ''} required={f.required} value={value} onChange={onChange} />;
          } else if (f.type === 'select') {
            input = (
              <select {...common} value={value} onChange={onChange}>
                {(f.options || []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
          } else {
            input = <input {...common} type={f.type || 'text'} maxLength={f.max} placeholder={f.placeholder || ''} required={f.required} inputMode={f.inputmode} autoComplete="off" value={value} onChange={onChange} />;
          }
          return (
            <label key={f.name} className="field">
              <span className="field-label">{f.label}{f.max ? <Counter value={value} max={f.max} /> : null}</span>
              {input}
              {f.hint ? <span className="hint">{f.hint}</span> : null}
            </label>
          );
        })}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={cancel}>취소</button>
          <button type="submit" ref={submitRef} className={danger ? 'btn btn-danger' : 'btn btn-primary'}>{confirm}</button>
        </div>
      </form>
    </Overlay>
  );
}

export function Counter({ value, max }: { value: string; max: number }) {
  const n = charCount(value);
  return <span className={`counter${n > max ? ' over' : ''}`}>{n} / {max}</span>;
}

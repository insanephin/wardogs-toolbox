import { charCount } from '../lib/format.ts';

export function KickMessage({ label, rows = 2, value, disabled, onChange }: { label: string; rows?: number; value: string; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label"><span>{label}</span><span>{`${charCount(value)}/200`}</span></span>
      <textarea rows={rows} maxLength={200} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

import { readFileSync, writeFileSync, renameSync, existsSync, watchFile } from 'node:fs';

export interface WeaponLookup {
  name(cause: string | null | undefined): string | null;
}

export type WeaponRenames = [cause: string, name: string][];

const SAVE_DELAY_MS = 1000;
const WATCH_MS = 2000;

const defaultWeaponName = (cause: string) => cause.replace(/^Id\.Item\./, '').replace(/_/g, ' ');

export class WeaponNames implements WeaponLookup {
  #path: string;
  #names: Record<string, string> = {};
  #saveTimer: NodeJS.Timeout | null = null;
  #written = '';

  constructor(path: string) {
    this.#path = path;
    this.#names = this.#read() ?? {};
  }

  name(cause: string | null | undefined): string | null {
    if (!cause) return null;
    const known = this.#names[cause];
    if (known) return known;
    const name = defaultWeaponName(cause);
    this.#names[cause] = name;
    this.#scheduleSave();
    return name;
  }

  readOnly(): WeaponLookup {
    return { name: (cause) => (cause ? this.#names[cause] || defaultWeaponName(cause) : null) };
  }

  watch(onRenamed: (renames: WeaponRenames) => void): void {
    watchFile(this.#path, { interval: WATCH_MS, persistent: false }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs) return;
      const renames = this.reload();
      if (renames.length) onRenamed(renames);
    });
  }

  reload(): WeaponRenames {
    const next = this.#read();
    if (!next) return [];
    const renames: WeaponRenames = [];
    for (const cause of new Set([...Object.keys(this.#names), ...Object.keys(next)])) {
      const before = this.#names[cause] || defaultWeaponName(cause);
      const after = next[cause] || defaultWeaponName(cause);
      if (before !== after) renames.push([cause, after]);
    }
    const missing = Object.keys(this.#names).filter((c) => !(c in next));
    this.#names = { ...next, ...Object.fromEntries(missing.map((c) => [c, defaultWeaponName(c)])) };
    if (missing.length) this.#scheduleSave();
    if (renames.length) console.log(`[무기] 이름표를 다시 읽었습니다: ${renames.length}개 변경`);
    return renames;
  }

  #read(): Record<string, string> | null {
    if (!existsSync(this.#path)) return {};
    const raw = readFileSync(this.#path, 'utf8');
    if (raw === this.#written) return null;
    try {
      const parsed = JSON.parse(raw || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('객체가 아닙니다');
      return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, (v as string).trim()]));
    } catch (err) {
      console.warn(`[무기] ${this.#path}를 읽지 못해 이전 이름표를 유지합니다: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      this.#save();
    }, SAVE_DELAY_MS);
    this.#saveTimer.unref();
  }

  #save(): void {
    this.reload();
    const sorted = Object.fromEntries(Object.entries(this.#names).sort(([a], [b]) => a.localeCompare(b)));
    const text = `${JSON.stringify(sorted, null, 2)}\n`;
    try {
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, this.#path);
      this.#written = text;
    } catch (err) {
      console.warn(`[무기] ${this.#path}에 새 무기를 저장하지 못했습니다: ${err instanceof Error ? err.message : err}`);
    }
  }
}

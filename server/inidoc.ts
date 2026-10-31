const SESSION_SECTION = '/Script/WDGame.WDGameSession';
const ROTATION_SECTION = '/Script/WDGame.WDServerMapRotationSettings';
const RESERVED_KEY = 'DefaultReservedPlayerIds';
const ROTATION_KEY = 'RotationEntries';

interface KeyLine {
  op: string;
  key: string;
  value: string;
}

interface SectionRange {
  name: string;
  start: number;
  end: number;
}

function splitKey(line: string): KeyLine | null {
  const m = /^\s*([+\-.!]?)([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (!m) return null;
  return { op: m[1], key: m[2], value: m[3].replace(/^"(.*)"$/, '$1') };
}

function sectionRanges(lines: string[]): SectionRange[] {
  const ranges: SectionRange[] = [];
  let current: SectionRange | null = null;
  lines.forEach((line, i) => {
    const m = /^\s*\[(.+)\]\s*$/.exec(line);
    if (m) {
      if (current) current.end = i;
      current = { name: m[1], start: i, end: lines.length };
      ranges.push(current);
    }
  });
  return ranges;
}

const isValue = (kv: KeyLine | null, key: string): kv is KeyLine => !!kv && kv.key === key && kv.op !== '!' && kv.op !== '-';

function getArray(text: string, section: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const sec = sectionRanges(lines).find((r) => r.name === section);
  if (!sec) return [];
  const values: string[] = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    const kv = splitKey(lines[i]);
    if (isValue(kv, key) && kv.value) values.push(kv.value);
  }
  return values;
}

function setArray(text: string, section: string, key: string, values: string[], { op = '+', clear = false } = {}): string {
  if (sameList(getArray(text, section, key), values)) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sec = sectionRanges(lines).find((r) => r.name === section);

  if (!sec) {
    const block = [`[${section}]`, ...(clear ? [`!${key}=ClearArray`] : []), ...values.map((v) => `${op}${key}=${v}`)];
    const tail = lines.length && lines[lines.length - 1] === '' ? '' : eol;
    return text + tail + eol + block.join(eol) + eol;
  }

  let at = -1;
  let hasClear = false;
  let opSeen = false;
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const kv = i > sec.start && i < sec.end ? splitKey(lines[i]) : null;
    if (kv && kv.key === key && kv.op === '!') hasClear = true;
    if (kv && kv.key === key && kv.op !== '!') {
      if (at < 0) at = kept.length;
      if (isValue(kv, key) && !opSeen) {
        op = kv.op || op;
        opSeen = true;
      }
      continue;
    }
    kept.push(lines[i]);
  }
  if (at < 0) {
    at = sec.end;
    while (at > sec.start + 1 && kept[at - 1].trim() === '') at--;
  }
  const insert = values.map((v) => `${op}${key}=${v}`);
  if (clear && !hasClear) insert.unshift(`!${key}=ClearArray`);
  kept.splice(at, 0, ...insert);
  return kept.join(eol);
}

export function getValue(text: string, section: string, key: string): string | null {
  const lines = text.split(/\r?\n/);
  const sec = sectionRanges(lines).find((r) => r.name === section);
  if (!sec) return null;
  let value: string | null = null;
  for (let i = sec.start + 1; i < sec.end; i++) {
    const kv = splitKey(lines[i]);
    if (kv && kv.key === key && !kv.op) value = kv.value;
  }
  return value;
}

export function setValue(text: string, section: string, key: string, value: string | number): string {
  if (getValue(text, section, key) === String(value)) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const sec = sectionRanges(lines).find((r) => r.name === section);
  if (!sec) {
    const tail = lines.length && lines[lines.length - 1] === '' ? '' : eol;
    return text + tail + eol + [`[${section}]`, `${key}=${value}`].join(eol) + eol;
  }
  let last = -1;
  for (let i = sec.start + 1; i < sec.end; i++) {
    const kv = splitKey(lines[i]);
    if (kv && kv.key === key && !kv.op) last = i;
  }
  if (last >= 0) {
    lines[last] = `${key}=${value}`;
  } else {
    let at = sec.end;
    while (at > sec.start + 1 && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, `${key}=${value}`);
  }
  return lines.join(eol);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function reservedIdsInDoc(text: string): string[] {
  return getArray(text, SESSION_SECTION, RESERVED_KEY);
}

export function setReservedInDoc(text: string, steamId: string, present: boolean): string {
  const ids = reservedIdsInDoc(text);
  if (present === ids.includes(steamId)) return text;
  return setArray(text, SESSION_SECTION, RESERVED_KEY, present ? [...ids, steamId] : ids.filter((id) => id !== steamId));
}

export interface RotationEntry {
  map: string;
  experiences: string[];
  lighting: string;
  alternator: string;
}

export interface RotationSelection {
  map: string;
  experiences?: string[];
  lighting?: string;
  alternator?: string;
}

export function parseRotationEntry(raw: string): RotationEntry {
  const entry: RotationEntry = { map: '', experiences: [], lighting: '', alternator: 'None' };
  const inner = String(raw).trim().replace(/^\(|\)$/g, '');
  for (const m of inner.matchAll(/(\w+)=(?:"([^"]*)"|([^,]*))/g)) {
    const value = (m[2] ?? m[3] ?? '').trim();
    if (m[1] === 'Map') entry.map = value;
    else if (m[1] === 'Experience' && value) entry.experiences.push(value);
    else if (m[1] === 'Experiences' && value) entry.experiences.push(...value.split('+').filter(Boolean));
    else if (m[1] === 'Lighting') entry.lighting = value;
    else if (m[1] === 'ZoneAlternator') entry.alternator = value || 'None';
  }
  return entry;
}

export function formatRotationEntry({ map, experiences, lighting, alternator }: RotationSelection): string {
  const q = (v: string) => `"${String(v).replace(/"/g, '')}"`;
  const parts = [`Map=${q(map)}`];
  const ids = (experiences || []).filter(Boolean);
  if (ids.length === 1) parts.push(`Experience=${q(ids[0])}`);
  else if (ids.length > 1) parts.push(`Experiences=${q(ids.join('+'))}`);
  if (lighting) parts.push(`Lighting=${q(lighting)}`);
  if (alternator && alternator !== 'None') parts.push(`ZoneAlternator=${q(alternator)}`);
  return `(${parts.join(',')})`;
}

export function sameSelection(entry: RotationEntry, sel: RotationSelection): boolean {
  const key = (v: string | undefined) => (!v || v === 'None' ? '' : String(v));
  const set = (ids: string[] | undefined) => [...(ids || [])].sort().join('+');
  return entry.map === sel.map
    && set(entry.experiences) === set(sel.experiences)
    && key(entry.lighting) === key(sel.lighting)
    && key(entry.alternator) === key(sel.alternator);
}

export function rotationEntriesInDoc(text: string): string[] {
  return getArray(text, ROTATION_SECTION, ROTATION_KEY);
}

export function setRotationInDoc(text: string, entries: string[]): string {
  return setArray(text, ROTATION_SECTION, ROTATION_KEY, entries, { op: '.', clear: true });
}

export interface RotationSettings {
  enabled?: boolean;
  mode?: 'ordered' | 'random';
}

export function setRotationSettingsInDoc(text: string, { enabled, mode }: RotationSettings): string {
  let out = text;
  if (enabled !== undefined) out = setValue(out, ROTATION_SECTION, 'bEnabled', enabled ? 'True' : 'False');
  if (mode !== undefined) out = setValue(out, ROTATION_SECTION, 'RotationMode', mode === 'random' ? 'Random' : 'Ordered');
  return out;
}

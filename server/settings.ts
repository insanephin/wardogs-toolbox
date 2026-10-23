import { HttpError } from './http.ts';
import { getValue, setValue } from './inidoc.ts';

const S_SESSION = '/Script/WDGame.WDGameSession';
const S_ENGINE = '/Script/Engine.GameSession';
const S_PREMATCH = 'MatchState.PreMatch.WaitingForPlayers.PlayerCount';
const S_KOTH = 'MatchState.Playing.KOTH';
const S_STATE = '/Script/WDGame.WDGameStateSession';
const S_ROTATION = '/Script/WDGame.WDServerMapRotationSettings';

type Value = string | number | boolean;

export interface SettingField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'bool' | 'enum';
  section: string;
  ini: string;
  def: Value;
  min?: number;
  max?: number;
  maxLength?: number;
  options?: { value: string; label: string }[];
  hint?: string;
  secret?: boolean;
}

export const SETTING_FIELDS: SettingField[] = [
  { key: 'serverName', label: '서버 이름', type: 'text', section: S_SESSION, ini: 'ServerName', def: '', maxLength: 64 },
  { key: 'maxPlayers', label: '최대 인원', type: 'number', section: S_ENGINE, ini: 'MaxPlayers', def: 128, min: 1 },
  { key: 'serverPassword', label: '접속 비밀번호', type: 'text', section: S_SESSION, ini: 'ServerPassword', def: '', maxLength: 64, secret: true, hint: '비워 두면 누구나 들어옵니다.' },
  { key: 'minPlayerCash', label: '최소 소지금', type: 'number', section: S_SESSION, ini: 'ServerMinPlayerCash', def: 0, min: 0, hint: '0은 제한 없음' },
  { key: 'maxPlayerCash', label: '최대 소지금', type: 'number', section: S_SESSION, ini: 'ServerMaxPlayerCash', def: 0, min: 0, hint: '0은 제한 없음' },
  { key: 'minPlayerLevel', label: '최소 레벨', type: 'number', section: S_SESSION, ini: 'ServerMinPlayerLevel', def: 0, min: 0, hint: '0은 제한 없음' },
  { key: 'maxPlayerLevel', label: '최대 레벨', type: 'number', section: S_SESSION, ini: 'ServerMaxPlayerLevel', def: 0, min: 0, hint: '0은 제한 없음' },
  { key: 'imageUrl', label: '스폰서 이미지 URL', type: 'text', section: S_SESSION, ini: 'ServerImageURL', def: '', maxLength: 300, hint: '서버 목록에 보이는 배너 이미지' },
  { key: 'maxReservedSlots', label: '예약 슬롯 수', type: 'number', section: S_SESSION, ini: 'MaxReservedSlots', def: 20, min: 0, hint: '비워 두는 자리 수' },
  { key: 'minRequiredPlayers', label: '매치 시작 최소 인원', type: 'number', section: S_PREMATCH, ini: 'MinimumRequiredPlayers', def: 60, min: 0 },
  { key: 'scorePeriod', label: '점수 주기 (초)', type: 'number', section: S_KOTH, ini: 'ScorePeriod', def: 24, min: 18, max: 30 },
  { key: 'lockOverpopulated', label: '팀 밸런스: 인원 많은 팀 잠금', type: 'bool', section: S_STATE, ini: 'bLockOverpopulatedTeamsConfig', def: true },
  { key: 'overpopThreshold', label: '팀 밸런스: 인원 차이 기준', type: 'number', section: S_STATE, ini: 'OverpopulatedTeamThresholdConfig', def: 2, min: 0 },
  { key: 'rotationEnabled', label: '맵 로테이션', type: 'bool', section: S_ROTATION, ini: 'bEnabled', def: true },
  { key: 'rotationMode', label: '로테이션 순서', type: 'enum', section: S_ROTATION, ini: 'RotationMode', def: 'Ordered',
    options: [{ value: 'Ordered', label: '순서대로' }, { value: 'Random', label: '무작위' }] },
];

const byKey = new Map(SETTING_FIELDS.map((f) => [f.key, f]));

function parse(field: SettingField, raw: string | null): Value | null {
  if (raw == null) return null;
  if (field.type === 'bool') return /^true$/i.test(raw.trim());
  if (field.type === 'number') return Number.isFinite(Number(raw)) && raw.trim() !== '' ? Number(raw) : null;
  if (field.type === 'enum') return field.options!.find((o) => o.value.toLowerCase() === raw.trim().toLowerCase())?.value ?? raw;
  return raw;
}

export function readSettings(text: string): Record<string, Value | null> {
  return Object.fromEntries(SETTING_FIELDS.map((f) => [f.key, parse(f, getValue(text, f.section, f.ini))]));
}

function serialize(field: SettingField, value: unknown): string {
  const bad = (msg: string) => new HttpError(400, 'bad_setting', `${field.label}: ${msg}`);
  if (field.type === 'bool') {
    if (typeof value !== 'boolean') throw bad('켜기/끄기 값이 아닙니다');
    return value ? 'True' : 'False';
  }
  if (field.type === 'number') {
    const n = Number(value);
    if (value === '' || value == null || !Number.isInteger(n)) throw bad('정수를 입력하세요');
    if (field.min != null && n < field.min) throw bad(`${field.min} 이상이어야 합니다`);
    if (field.max != null && n > field.max) throw bad(`${field.max} 이하여야 합니다`);
    return String(n);
  }
  if (field.type === 'enum') {
    const v = field.options!.find((o) => o.value === value);
    if (!v) throw bad('고를 수 있는 값이 아닙니다');
    return v.value;
  }
  const s = typeof value === 'string' ? value.trim() : '';
  if (/[\r\n]/.test(s)) throw bad('줄바꿈은 쓸 수 없습니다');
  if (field.maxLength && [...s].length > field.maxLength) throw bad(`최대 ${field.maxLength}자입니다`);
  return s;
}

export function writeSettings(text: string, values: Record<string, unknown>): { text: string; keys: string[] } {
  let out = text;
  const keys: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key);
    if (!field) throw new HttpError(400, 'unknown_setting', `모르는 설정입니다: ${key}`);
    const next = setValue(out, field.section, field.ini, serialize(field, value));
    if (next !== out) keys.push(key);
    out = next;
  }
  return { text: out, keys };
}

export function lockedSettings(sections: { section?: string; keyOverrides?: { key?: string; writable?: boolean; lockedBy?: string }[] }[]): Record<string, string> {
  const locked: Record<string, string> = {};
  for (const s of sections) {
    for (const o of s.keyOverrides || []) {
      if (o.writable !== false) continue;
      const field = SETTING_FIELDS.find((f) => f.section === s.section && f.ini === o.key);
      if (field) locked[field.key] = o.lockedBy || '명령줄 인자';
    }
  }
  return locked;
}

type Section = { section?: string; appliesWhen?: string; description?: string; keyOverrides?: { key?: string; appliesWhen?: string; description?: string }[] };

export function appliesSettings(sections: Section[]): Record<string, { state: string; description: string | null }> {
  const out: Record<string, { state: string; description: string | null }> = {};
  for (const f of SETTING_FIELDS) {
    const s = sections.find((x) => x.section === f.section);
    if (!s) continue;
    const o = (s.keyOverrides || []).find((k) => String(k.key).toLowerCase() === f.ini.toLowerCase());
    const state = o?.appliesWhen ?? s.appliesWhen;
    if (state) out[f.key] = { state, description: (o?.appliesWhen ? o.description : s.description) ?? null };
  }
  return out;
}

export interface ConfigPreset {
  name: string;
  values: Record<string, Value>;
  savedAt: number;
  savedBy: string;
}

export function presetValues(values: Record<string, unknown>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key);
    if (!field || field.secret) continue;
    serialize(field, value);
    out[key] = value as Value;
  }
  return out;
}

import type { Role } from './types.ts';

export const ROLE_LABEL: Record<Role, string> = { viewer: '뷰어', mod: '모더레이터', admin: '관리자', owner: '소유자' };
export const PROVIDER_LABEL: Record<string, string> = { steam: '스팀', discord: '디스코드', chzzk: '치지직', twitch: '트위치' };
export const OUTCOME_LABEL: Record<string, string> = { applied: '즉시 적용', 'next-match': '다음 매치', 'next-restart': '서버 재시작 후', pending: '적용 시 확인' };

export const MODIFIER_LABEL: Record<string, string> = { KOTH_InfantryOnly: '보병 전용', KOTH_Hardcore: '하드코어', KOTH_LimitedGear: '장비 제한' };
export const BASE_MODE_LABEL = '점령전';
export const isBaseMode = (id: string) => /_KOTH_\d+$/.test(id);
export function modesLabel(experiences: string[]): string {
  const mods = experiences.filter((id) => !isBaseMode(id)).map((id) => MODIFIER_LABEL[id] ?? id);
  return mods.length ? mods.join(' · ') : experiences.length ? BASE_MODE_LABEL : '';
}

export const LIGHTING: Record<string, { label: string; hint: string }> = {
  DayStartClear: { label: '일출 · 맑음', hint: '해가 낮아 역광과 긴 그림자가 생기고, 바라보는 방향에 따라 눈부심이 다릅니다.' },
  DayEarlyClear: { label: '아침 · 맑음', hint: '시야가 좋습니다.' },
  DayEarlyFog: { label: '아침 · 안개', hint: '시야 거리가 줄어 저격·장거리 교전이 불리하고 근접전이 늘어납니다.' },
  DayClear: { label: '한낮 · 맑음', hint: '시야가 가장 좋은 기준 조명입니다.' },
  DayLateClear: { label: '늦은 오후 · 맑음', hint: '시야가 좋고 그림자가 길어지기 시작합니다.' },
  DayLateGray: { label: '늦은 오후 · 흐림', hint: '화면이 어두워 위장한 적(길리슈트 등)을 알아보기 어렵습니다.' },
  DayLateGrayFog: { label: '늦은 오후 · 흐림+안개', hint: '어둡고 시야 거리도 짧아 장거리 교전에 가장 불리합니다.' },
  DayLateRain: { label: '늦은 오후 · 비', hint: '어둡고 시야가 떨어져 위장한 적을 알아보기 어렵습니다.' },
  DayEndClear: { label: '해질녘 · 맑음', hint: '해가 낮아 역광과 긴 그림자가 생기고, 바라보는 방향에 따라 눈부심이 다릅니다.' },
};
const MAP_LIGHTINGS: Record<string, string[]> = { Russia: ['DayClear', 'DayLateClear', 'DayLateGray', 'DayLateRain'] };
export function lightingsForMap<T extends { id: string }>(map: string | null | undefined, lightings: T[]): T[] {
  const allowed = map ? MAP_LIGHTINGS[map] : undefined;
  if (!allowed) return lightings;
  const narrowed = lightings.filter((l) => allowed.includes(l.id));
  return narrowed.length ? narrowed : lightings;
}
export const lightingLabel = (id: string | null | undefined) => (id ? LIGHTING[id]?.label ?? id : '');

export const ALTERNATOR: Record<string, { label: string; hint: string }> = {
  'ZoneAlternator.Factory.Circle': { label: '공장 원형 구역', hint: '바쿠라니 공장 지대에 원형 점령구역 하나를 고정합니다.' },
  'ZoneAlternator.Factory.Split': { label: '공장 분할 구역', hint: '공장 지대 점령구역을 여러 조각으로 나누는 변형으로 보입니다. 공식 설명이 없어 서버에서 확인이 필요합니다.' },
};
export const ALTERNATOR_DEFAULT_HINT = '맵에 정해진 기본 순환을 씁니다. 바쿠라니는 Default·Farmland·Lumberyard를 돌며 Default가 다른 곳보다 2배 자주 나옵니다.';
export const alternatorLabel = (tag: string | null | undefined) => (tag && tag !== 'None' ? ALTERNATOR[tag]?.label ?? tag : '');

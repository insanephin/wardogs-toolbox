import type { Role } from './types.ts';

export const ROLE_LABEL: Record<Role, string> = { viewer: '뷰어', mod: '모더레이터', admin: '관리자', owner: '소유자' };
export const PROVIDER_LABEL: Record<string, string> = { steam: '스팀', discord: '디스코드', chzzk: '치지직', twitch: '트위치' };

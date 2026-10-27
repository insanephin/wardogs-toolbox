import { randomBytes } from 'node:crypto';
import { ROLES } from './store.ts';
import { STEAM_ID } from './http.ts';
import type { Role } from './store.ts';

const RANK: Record<Role, number> = Object.fromEntries(ROLES.map((r, i) => [r, i + 1])) as Record<Role, number>;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type { Role };

export interface Session {
  steamId: string;
  name: string;
  superadmin: boolean;
  expires: number;
}

export const isRole = (r: unknown): r is Role => typeof r === 'string' && Object.hasOwn(RANK, r);

export function parseSuperadmins(spec: string): Set<string> {
  const ids = new Set<string>();
  for (const id of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!STEAM_ID.test(id)) throw new Error(`SUPERADMIN_STEAM_IDS entry "${id}" must be a 17-digit SteamID64`);
    ids.add(id);
  }
  return ids;
}

export class Auth {
  superadmins: Set<string>;
  sessions = new Map<string, Session>();

  constructor(superadminSpec: string) {
    this.superadmins = parseSuperadmins(superadminSpec);
  }

  login(steamId: string, name: string): string {
    const now = Date.now();
    for (const [k, s] of this.sessions) if (s.expires < now) this.sessions.delete(k);
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { steamId, name: name || steamId, superadmin: this.superadmins.has(steamId), expires: now + SESSION_TTL_MS });
    return id;
  }

  session(id: string | undefined): Session | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  logout(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }
}

export function hasRole(role: Role | null | undefined, needed: Role): boolean {
  return !!role && RANK[role] >= RANK[needed];
}

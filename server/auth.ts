import { createHash, randomBytes } from 'node:crypto';
import { ROLES } from './store.ts';
import type { Store } from './store.ts';
import { STEAM_ID } from './http.ts';
import type { Role } from './store.ts';

const RANK: Record<Role, number> = Object.fromEntries(ROLES.map((r, i) => [r, i + 1])) as Record<Role, number>;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type { Role };

export interface Session {
  steamId: string;
  name: string;
  superadmin: boolean;
  guest?: boolean;
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

const hashToken = (id: string) => createHash('sha256').update(id).digest('base64url');

export class Auth {
  superadmins: Set<string>;
  #store: Store;

  constructor(superadminSpec: string, store: Store) {
    this.superadmins = parseSuperadmins(superadminSpec);
    this.#store = store;
  }

  login(steamId: string, name: string, guest = false): string {
    const id = randomBytes(32).toString('base64url');
    this.#store.saveSession(hashToken(id), { steamId, name: name || steamId, guest, expires: Date.now() + SESSION_TTL_MS });
    return id;
  }

  session(id: string | undefined): Session | null {
    if (!id) return null;
    const s = this.#store.session(hashToken(id));
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.#store.deleteSession(hashToken(id));
      return null;
    }
    return { steamId: s.steamId, name: s.name, superadmin: !s.guest && this.superadmins.has(s.steamId), ...(s.guest && { guest: true }), expires: s.expires };
  }

  logout(id: string | undefined): void {
    if (id) this.#store.deleteSession(hashToken(id));
  }
}

export function hasRole(role: Role | null | undefined, needed: Role): boolean {
  return !!role && RANK[role] >= RANK[needed];
}

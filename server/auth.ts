import { randomBytes } from 'node:crypto';

const ROLES = { viewer: 1, mod: 2, admin: 3 };
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type Role = keyof typeof ROLES;

export interface Session {
  channelId: string;
  name: string;
  role: Role;
  expires: number;
}

const isRole = (r: string): r is Role => Object.hasOwn(ROLES, r);

export function parseAdmins(spec: string): Map<string, Role> {
  const admins = new Map<string, Role>();
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id = '', role = 'admin'] = raw.split(':');
    if (!/^[0-9a-f]{32}$/.test(id) || !isRole(role)) {
      throw new Error(`ADMIN_CHZZK_IDS entry "${raw}" must be a 32-character Chzzk channel ID, optionally :viewer|mod|admin`);
    }
    admins.set(id, role);
  }
  return admins;
}

export class Auth {
  admins: Map<string, Role>;
  sessions = new Map<string, Session>();

  constructor(adminSpec: string) {
    this.admins = parseAdmins(adminSpec);
  }

  login(channelId: string, channelName: string): string | null {
    const role = this.admins.get(channelId);
    if (!role) return null;
    const now = Date.now();
    for (const [k, s] of this.sessions) if (s.expires < now) this.sessions.delete(k);
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { channelId, name: channelName || channelId, role, expires: now + SESSION_TTL_MS });
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

export function hasRole(session: Session | null, needed: Role): boolean {
  return !!session && ROLES[session.role] >= ROLES[needed];
}

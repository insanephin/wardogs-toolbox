// The RCON token grants everything, so this layer is where permissions get split.

import { randomBytes, timingSafeEqual } from 'node:crypto';

const ROLES = { viewer: 1, mod: 2, admin: 3 };
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type Role = keyof typeof ROLES;

interface User {
  name: string;
  role: Role;
  password: string;
}

export interface Session {
  name: string;
  role: Role;
  expires: number;
}

const isRole = (r: string): r is Role => Object.hasOwn(ROLES, r);

function verifyPassword(stored: string, given: string): boolean {
  const a = Buffer.from(stored);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// "name:role:password,name2:role:password". Passwords may contain ':'.
export function parseUsers(spec: string): Map<string, User> {
  const users = new Map<string, User>();
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, role = '', ...rest] = raw.split(':');
    const password = rest.join(':');
    if (!name || !isRole(role) || !password) {
      throw new Error(`DASH_USERS entry "${name || raw}" must be name:role:password with role viewer|mod|admin`);
    }
    users.set(name, { name, role, password });
  }
  return users;
}

export class Auth {
  users: Map<string, User>;
  sessions = new Map<string, Session>();
  failures = new Map<string | undefined, { count: number; until: number }>(); // by IP

  constructor(userSpec: string) {
    this.users = parseUsers(userSpec);
  }

  login(name: string, password: unknown, ip: string | undefined) {
    const f = this.failures.get(ip);
    if (f && f.until > Date.now()) return { error: 'too_many_attempts' } as const;
    const user = this.users.get(name);
    if (!user || !verifyPassword(user.password, String(password ?? ''))) {
      const count = (f?.count ?? 0) + 1;
      this.failures.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
      return { error: 'invalid_credentials' } as const;
    }
    this.failures.delete(ip);
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, { name: user.name, role: user.role, expires: Date.now() + SESSION_TTL_MS });
    return { id, user: { name: user.name, role: user.role } };
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

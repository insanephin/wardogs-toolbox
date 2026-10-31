import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

export interface SecretBox {
  enabled: boolean;
  seal(plain: string): string;
  open(stored: string): string;
}

export const isSealed = (v: string) => v.startsWith(PREFIX);

function parseSecretKey(spec: string): Buffer | null {
  if (!spec) return null;
  const key = Buffer.from(spec, 'base64');
  if (key.length !== 32) throw new Error('DB_SECRET_KEY must be 32 random bytes in base64 (openssl rand -base64 32)');
  return key;
}

export function createSecretBox(spec: string): SecretBox {
  const key = parseSecretKey(spec);
  return {
    enabled: !!key,
    seal(plain) {
      if (!key || !plain) return plain;
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
    },
    open(stored) {
      if (!isSealed(stored)) return stored;
      if (!key) throw new Error('DB에 암호화된 RCON 비밀번호가 있지만 DB_SECRET_KEY가 설정되지 않았습니다');
      const raw = Buffer.from(stored.slice(PREFIX.length), 'base64url');
      try {
        const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        d.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
      } catch {
        throw new Error('RCON 비밀번호를 복호화하지 못했습니다. DB_SECRET_KEY가 암호화할 때 쓴 키와 다릅니다');
      }
    },
  };
}

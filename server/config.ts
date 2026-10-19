function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    host: env.DASH_HOST || '127.0.0.1',
    port: int('DASH_PORT', 8080),
    users: env.DASH_USERS || '',
    rconUrl: (env.RCON_URL || 'http://127.0.0.1:7776').replace(/\/+$/, ''),
    rconPassword: env.RCON_PASSWORD || '',
    feedToken: env.FEED_TOKEN || '',
    engagementGapSec: int('ENGAGEMENT_GAP_SEC', 15),
    engagementMinKills: int('ENGAGEMENT_MIN_KILLS', 3),
    dbPath: env.DB_PATH || 'data/dashboard.db',
    // Behind a TLS proxy the cookie must be Secure; set COOKIE_SECURE=true there.
    cookieSecure: env.COOKIE_SECURE === 'true',
    // Discord bot's OAuth callback server. Players land on /callback/* of this domain after
    // signing in to Chzzk/Steam; they are forwarded there instead of seeing the admin login.
    botUrl: (env.BOT_URL || '').replace(/\/+$/, ''),
  };
}

export type Config = ReturnType<typeof loadConfig>;

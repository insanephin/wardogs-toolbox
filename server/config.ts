function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const chzzkRedirect = env.CHZZK_REDIRECT_URL || '';
  const publicUrl = (env.PUBLIC_URL || (chzzkRedirect ? new URL(chzzkRedirect).origin : '')).replace(/\/+$/, '');
  const callback = (name: string) => (publicUrl ? `${publicUrl}/callback/${name}` : '');
  return {
    host: env.DASH_HOST || '127.0.0.1',
    port: int('DASH_PORT', 8080),
    admins: env.ADMIN_CHZZK_IDS || '',
    rconUrl: (env.RCON_URL || 'http://127.0.0.1:7776').replace(/\/+$/, ''),
    rconPassword: env.RCON_PASSWORD || '',
    feedToken: env.FEED_TOKEN || '',
    engagementGapSec: int('ENGAGEMENT_GAP_SEC', 15),
    engagementMinKills: int('ENGAGEMENT_MIN_KILLS', 3),
    dbPath: env.DB_PATH || 'data/dashboard.db',
    cookieSecure: env.COOKIE_SECURE === 'true',
    trustProxy: env.TRUST_PROXY === 'true',
    adminAllowIps: (env.ADMIN_ALLOW_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
    chzzk: {
      clientId: env.CHZZK_CLIENT_ID || '',
      clientSecret: env.CHZZK_CLIENT_SECRET || '',
      redirectUrl: chzzkRedirect || callback('chzzk'),
    },
    steam: {
      apiKey: env.STEAM_WEB_API_KEY || '',
      returnUrl: env.STEAM_RETURN_URL || callback('steam'),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;

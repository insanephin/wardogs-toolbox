function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const absolute = (v: string) => (/^https?:\/\//.test(v) ? v : '');
  const publicUrl = (env.PUBLIC_URL || (absolute(env.CHZZK_REDIRECT_URL || '') && new URL(env.CHZZK_REDIRECT_URL!).origin)).replace(/\/+$/, '');
  const redirect = (name: string, value: string | undefined) => {
    const v = (value || `/callback/${name}`).trim();
    if (absolute(v)) return v;
    return publicUrl ? `${publicUrl}${v.startsWith('/') ? v : `/${v}`}` : '';
  };
  return {
    host: '0.0.0.0',
    port: 8080,
    superadmins: env.SUPERADMIN_STEAM_IDS || '',
    feedToken: env.FEED_TOKEN || '',
    engagementGapSec: int('ENGAGEMENT_GAP_SEC', 15),
    engagementMinKills: int('ENGAGEMENT_MIN_KILLS', 3),
    dbPath: env.DB_PATH || 'data/dashboard.db',
    dbSecretKey: env.DB_SECRET_KEY || '',
    cookieSecure: env.COOKIE_SECURE === 'true',
    redis: {
      host: env.REDIS_HOST || '',
      port: int('REDIS_PORT', 6379),
      password: env.REDIS_PASSWORD || '',
      db: int('REDIS_DB', 0),
      prefix: env.REDIS_PREFIX ?? 'wardogs:',
    },
    chzzk: {
      clientId: env.CHZZK_CLIENT_ID || '',
      clientSecret: env.CHZZK_CLIENT_SECRET || '',
      redirectUrl: redirect('chzzk', env.CHZZK_REDIRECT_URL),
    },
    steam: {
      apiKey: env.STEAM_WEB_API_KEY || '',
      returnUrl: redirect('steam', env.STEAM_RETURN_URL),
    },
    publicUrl,
    mapArtUrl: env.MAP_ART_URL ?? 'http://rcon.wardogs.com/img/maps',
    discord: {
      botSecret: env.DISCORD_BOT_SECRET || '',
      botClientId: env.DISCORD_BOT_CLIENT_ID || env.DISCORD_CLIENT_ID || '',
      botClientSecret: env.DISCORD_BOT_CLIENT_SECRET
        || (!env.DISCORD_BOT_CLIENT_ID || env.DISCORD_BOT_CLIENT_ID === env.DISCORD_CLIENT_ID ? env.DISCORD_CLIENT_SECRET || '' : ''),
      botRedirectUrl: redirect('discord-bot', env.DISCORD_BOT_REDIRECT_URL),
      legacyServerId: int('DISCORD_SERVER_ID', 1),
      clientId: env.DISCORD_CLIENT_ID || '',
      clientSecret: env.DISCORD_CLIENT_SECRET || '',
      redirectUrl: redirect('discord', env.DISCORD_REDIRECT_URL),
    },
    twitch: {
      clientId: env.TWITCH_CLIENT_ID || '',
      clientSecret: env.TWITCH_CLIENT_SECRET || '',
      redirectUrl: redirect('twitch', env.TWITCH_REDIRECT_URL),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;

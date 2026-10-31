import { loadConfig } from './config.ts';
import { RconClient } from './rcon.ts';
import type { RconError } from './rcon.ts';
import { parseSuperadmins } from './auth.ts';
import { Store } from './store.ts';
import { connectKv } from './kv.ts';
import { existsSync } from 'node:fs';

const config = loadConfig();
let failed = false;
const ok = (msg: string) => console.log(`  [OK]   ${msg}`);
const bad = (msg: string, fix?: string) => {
  failed = true;
  console.log(`  [실패] ${msg}${fix ? `\n         → ${fix}` : ''}`);
};
const warn = (msg: string) => console.log(`  [주의] ${msg}`);

console.log('\n설정');
try {
  const supers = parseSuperadmins(config.superadmins);
  if (!supers.size) bad('SUPERADMIN_STEAM_IDS가 비어 있습니다', '.env에 전체 관리자의 SteamID64를 쉼표로 넣으세요');
  else ok(`전체 관리자 ${supers.size}명`);
  if (!config.steam.apiKey || !config.steam.returnUrl) bad('스팀 로그인 설정이 비어 있어 관리자 로그인을 할 수 없습니다', 'STEAM_WEB_API_KEY와 PUBLIC_URL(또는 STEAM_RETURN_URL)을 넣으세요');
  for (const [name, c] of [['디스코드', config.discord], ['치지직', config.chzzk], ['트위치', config.twitch]] as const) {
    if (c.clientId && c.clientSecret) ok(`${name} 연결 로그인 사용 가능`);
  }
} catch (err) {
  bad((err as Error).message);
}
try {
  const kv = await connectKv(config);
  await kv.close();
  ok(`Redis ${config.redis.host}:${config.redis.port} db${config.redis.db} 연결`);
} catch (err) {
  bad(`Redis에 연결하지 못했습니다: ${(err as Error).message}`, 'REDIS_HOST(필요하면 REDIS_PORT·REDIS_PASSWORD·REDIS_DB)를 확인하세요');
}
const servers = existsSync(config.dbPath) ? new Store(config.dbPath, { legacyFeedToken: config.feedToken, secretKey: config.dbSecretKey }).servers() : [];
if (!servers.length) warn("등록된 게임 서버가 없습니다. 관리자 패널 '서버 관리'에서 추가하세요");

for (const server of servers) {
  console.log(`\nRCON · #${server.id} ${server.name}`);
  if (!server.rconUrl) bad('RCON 주소가 없습니다', "관리자 패널 '연결 정보' 탭에서 입력하세요 (예: http://203.0.113.10:7776)");
  if (!server.rconPassword) bad('RCON 비밀번호가 없습니다', "관리자 패널 '연결 정보' 탭에서 입력하세요 (게임 서버 ini의 Password 또는 Saved/RCON/ADMIN-PASSWORD.txt 값)");
  if (!server.rconUrl || !server.rconPassword) continue;
  const rcon = new RconClient({ baseUrl: server.rconUrl, password: server.rconPassword, timeoutMs: 6000 });
  try {
    const caps = await rcon.loadCapabilities();
    ok(`연결·인증 성공 · 빌드 ${caps.build ?? '?'} · API v${caps.apiVersion ?? '?'} · 경로 ${caps.routes?.length ?? 0}개`);
    if (caps.limits?.maxRequestsPerMinutePerIp) ok(`요청 한도 분당 ${caps.limits.maxRequestsPerMinutePerIp}회`);
    const status = await rcon.status();
    ok(`서버 "${status.serverName}" · 맵 ${status.map} · ${status.players?.current ?? '?'}/${status.players?.max ?? '?'}명`);
    const players = await rcon.players();
    ok(`플레이어 목록 ${players.length}명`);
    const f = rcon.features;
    if (!f.changeTeam) warn('이 빌드는 진영 이동 경로가 없습니다');
    if (f.feed) {
      const feed = await rcon.feedHealth();
      if (!feed.enabled) warn('게임 서버의 이벤트 피드가 꺼져 있습니다 (bEventFeedEnabled)');
      else if (feed.anyUnhealthy) warn(`게임 서버가 피드 전송 실패를 보고합니다 (엔드포인트 ${feed.endpointCount}개 중 일부)`);
      else ok(`게임 서버 피드 전송 정상 (엔드포인트 ${feed.endpointCount}개)`);
    }
    if (!f.configDocument) warn('이 서버는 설정 문서 쓰기를 막아 두었습니다. 서버 설정·예약 슬롯·로테이션 편집이 안 됩니다');
  } catch (e) {
    const err = e as RconError;
    if (err.status === 401 || err.status === 403) {
      bad(`인증 거부 (${err.status})`, 'RCON 비밀번호가 게임 서버 비밀번호와 같은지 확인하세요');
    } else if (err.code === 'unreachable' || err.code === 'timeout') {
      bad(err.message, [
        '게임 서버에서 RCON이 켜져 있는지(bEnabled=true), 포트(기본 7776)가 맞는지 확인하세요.',
        '같은 컴퓨터의 게임 서버가 BindAddress=127.0.0.1이면 컨테이너에서 닿지 않습니다.',
        'AllowedHosts를 쓰는 서버라면 이 대시보드의 IP를 허용 목록에 넣으세요.',
      ].join('\n           '));
    } else if (err.status === 429) {
      bad('요청 한도 초과 (429)', '잠시 뒤 다시 실행하세요');
    } else {
      bad(`${err.status || ''} ${err.message}`);
    }
  }
}

console.log(failed ? '\n결과: 고칠 항목이 있습니다.\n' : '\n결과: 연결 준비 완료.\n');
process.exit(failed ? 1 : 0);

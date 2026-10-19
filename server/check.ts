// Connection test for a real server: reads the same settings as the dashboard and reports
// whether RCON is reachable, the password is accepted, and what this build serves.
// Usage: npm run check   (in Docker: docker compose run --rm dashboard npm run check)

import { loadConfig } from './config.ts';
import { RconClient } from './rcon.ts';
import type { RconError } from './rcon.ts';
import { parseUsers } from './auth.ts';

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
  const users = parseUsers(config.users);
  if (!users.size) bad('DASH_USERS가 비어 있습니다', '.env에 이름:역할:비밀번호 형식으로 계정을 넣으세요');
  else ok(`대시보드 계정 ${users.size}개 (${[...users.values()].map((u) => `${u.name}/${u.role}`).join(', ')})`);
} catch (err) {
  bad((err as Error).message);
}
if (!process.env.RCON_URL) bad('RCON_URL이 비어 있습니다', '예: http://203.0.113.10:7776 (게임 서버 주소와 RCON 포트)');
if (!config.rconPassword) bad('RCON_PASSWORD가 비어 있습니다', '게임 서버 ini의 Password 또는 Saved/RCON/ADMIN-PASSWORD.txt 값');
if (!config.feedToken) warn('FEED_TOKEN이 비어 있어 킬피드·교전 기능이 동작하지 않습니다');
else if (config.feedToken.length < 24) warn('FEED_TOKEN이 짧습니다. 24자 이상 무작위 값을 권장합니다');

console.log(`\nRCON ${config.rconUrl}`);
const rcon = new RconClient({ baseUrl: config.rconUrl, password: config.rconPassword, timeoutMs: 6000 });
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
    bad(`인증 거부 (${err.status})`, 'RCON_PASSWORD가 게임 서버 비밀번호와 같은지 확인하세요');
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

console.log(failed ? '\n결과: 고칠 항목이 있습니다.\n' : '\n결과: 연결 준비 완료.\n');
process.exit(failed ? 1 : 0);

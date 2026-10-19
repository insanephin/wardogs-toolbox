// Formatting helpers and display labels. React escapes text, so game strings (names, reasons)
// can be rendered directly; never pass them to dangerouslySetInnerHTML.
import type { FeedEvent } from './types.ts';

export const ACTION_LABELS: Record<string, string> = {
  message: '귓속말', kick: '킥', kill: '킬', move_faction: '진영 이동', broadcast: '전체 공지',
  ban: '밴', ban_queued: '밴 대기열 등록', unban: '밴 해제', ban_queue_remove: '밴 대기열 삭제',
  pending_ban_enforced: '대기 밴 집행', reserved_add: '예약 슬롯 추가', reserved_remove: '예약 슬롯 삭제',
  change_map: '맵 변경', score_period: '점수 주기 변경', end_match: '매치 종료', restart_match: '매치 재시작', set_lighting: '조명 변경',
  config_apply: '설정 적용', whitelist_update: '화이트리스트 변경', whitelist_kick: '미연동 킥',
  whitelist_ban: '미연동 밴', whitelist_unban: '미연동 밴 해제',
};

export const TAG_LABELS: Record<string, string> = {
  Headshot: '헤드샷', Penetration: '관통', Ricochet: '도탄', WeaponMelee: '근접', VehicleExplosion: '차량 폭발',
  RoadKill: '로드킬', Falling: '낙사', Suicide: '자살',
};

export const STATE_LABELS: Record<string, string> = {
  'MatchState.PreMatch': '매치 준비',
  'MatchState.PreMatch.WaitingForWorldLoad': '맵 로딩',
  'MatchState.PreMatch.WaitingForPlayers': '인원 대기',
  'MatchState.PreMatch.WaitingForPlayers.PlayerCount': '인원 대기',
  'MatchState.Playing': '진행 중',
  'MatchState.Playing.KOTH': '진행 중',
  'MatchState.PostMatch': '매치 종료',
};

export function fmtClock(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return '—';
  const s = Math.floor(sec);
  if (s < 60) return `${s}초`;
  if (s < 3600) return `${Math.floor(s / 60)}분`;
  const hrs = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  return hrs < 24 ? `${hrs}시간 ${min}분` : `${Math.floor(hrs / 24)}일 ${hrs % 24}시간`;
}

export function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return '방금';
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return d.toDateString() === new Date().toDateString() ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
}

export function fmtNum(n: number | null | undefined): string {
  return n == null ? '—' : Number(n).toLocaleString('ko-KR');
}

export function fmtDist(m: number | null | undefined): string {
  return m == null ? '—' : `${m >= 100 ? Math.round(m) : m.toFixed(1)}m`;
}

export function pct(part: number, whole: number): number | null {
  return whole ? Math.round((part / whole) * 100) : null;
}

// Counts code points, which is how the game measures its 256/200 limits.
export const charCount = (s: string): number => [...s].length;

// One-line text for a feed event. Kills from the audit list carry type 'killed'.
export function describeEvent(e: FeedEvent): string {
  switch (e.type) {
    case 'killed': return e.suicide
      ? `자살: ${e.victimName || e.victimSteamId || '?'}`
      : `킬: ${e.killerName || e.killerSteamId || '환경'} → ${e.victimName || e.victimSteamId || '?'}${e.weapon ? ` · ${e.weapon}` : ''}${e.distanceM != null ? ` · ${fmtDist(e.distanceM)}` : ''}`;
    case 'player_joined': return `입장: ${e.playerName} (현재 ${e.players}명)`;
    case 'player_left': return `퇴장: ${e.playerName} (현재 ${e.players}명)`;
    case 'match_state': return `매치 상태: ${(e.state && STATE_LABELS[e.state]) ?? e.state}${e.mapName ? ` · ${e.mapName}` : ''}`;
    case 'match_ended': {
      const scores = (e.factionScores || []).map((f) => `${f.faction} ${f.score}`).join(' / ');
      return `매치 결과: ${e.winningFaction || '무승부'} 승리 · ${scores}`;
    }
    default: return `${e.type}`;
  }
}

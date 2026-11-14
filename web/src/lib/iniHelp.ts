interface KeyHelp {
  label: string;
  text: string;
  kind?: 'list';
}

interface SectionHelp {
  label: string;
  text?: string;
  keys: Record<string, KeyHelp>;
}

export const FILE_HELP = '여기 있는 키만 적용됩니다. 서버 허용 목록(DedicatedServerEngine.ini의 AllowedConfigs)에 없는 섹션·키는 지워지므로 다른 키를 넣어도 효과가 없습니다. 쓰지 않을 줄은 지우거나 ";"로 주석 처리하세요. 빠진 키는 기본값을 씁니다.';

export const INI_HELP: Record<string, SectionHelp> = {
  '/Script/WDGame.WDGameSession': {
    label: '서버 정보',
    text: '서버 이름·비밀번호·입장 조건·밴·예약 슬롯·스폰서 배너.',
    keys: {
      ServerName: { label: '서버 이름', text: '서버 목록에 보이는 이름.' },
      ServerPassword: { label: '접속 비밀번호', text: '비워 두면 누구나 들어올 수 있습니다. 바꾸면 새 접속부터 바로 막고, 이미 접속한 플레이어는 다시 확인하지 않습니다.' },
      ServerMinPlayerCash: { label: '최소 보유 금액', text: '이보다 돈이 적은 플레이어는 들어올 수 없습니다. 0 = 제한 없음. 이미 접속한 플레이어는 내보내지 않습니다.' },
      ServerMaxPlayerCash: { label: '최대 보유 금액', text: '이보다 돈이 많은 플레이어는 들어올 수 없습니다. 0 = 제한 없음.' },
      ServerMinPlayerLevel: { label: '최소 레벨', text: '이보다 레벨이 낮은 플레이어는 들어올 수 없습니다. 0 = 제한 없음.' },
      ServerMaxPlayerLevel: { label: '최대 레벨', text: '이보다 레벨이 높은 플레이어는 들어올 수 없습니다. 0 = 제한 없음.' },
      ServerImageURL: { label: '스폰서 배너', text: '서버 목록 배너 이미지 URL. 1024x256 PNG/JPEG이어야 하고 서버의 이미지 허용 목록에 있어야 합니다. 적용하면 백그라운드에서 받아 검증한 뒤 표시합니다.' },
      MaxReservedSlots: { label: '예약 슬롯 수', text: '예약 슬롯 플레이어를 위해 비워 두는 자리의 최대 개수.' },
      DefaultReservedPlayerIds: { label: '예약 슬롯 목록', kind: 'list', text: 'SteamID64 하나당 한 줄. RCON 예약 추가/삭제 명령이 이 목록을 고치고 이 파일에 다시 저장합니다.' },
      DefaultBannedPlayerIds: { label: '밴 목록', kind: 'list', text: 'SteamID64 하나당 한 줄. RCON 밴/밴 해제 명령이 이 목록을 고치고 이 파일에 다시 저장합니다.' },
    },
  },
  '/Script/Engine.GameSession': {
    label: '최대 인원',
    text: '실행 중인 서버에는 적용하지 않으므로 재시작 후 반영됩니다.',
    keys: {
      MaxPlayers: { label: '최대 인원', text: '개발사가 정한 최소·최대 허용 인원(Lowest/HighestAllowedMaxPlayers) 범위로 잘립니다.' },
    },
  },
  'MatchState.PreMatch.WaitingForPlayers.PlayerCount': {
    label: '매치 시작 조건',
    text: '다음 매치 대기가 시작될 때 읽습니다.',
    keys: {
      MinimumRequiredPlayers: { label: '시작 최소 인원', text: '매치 대기에서 매치로 넘어가는 데 필요한 인원.' },
    },
  },
  'MatchState.Playing.KOTH': {
    label: '점령전 점수',
    text: '라운드 도중에는 점수 주기가 바뀌지 않고 다음 매치부터 적용됩니다.',
    keys: {
      ScorePeriod: { label: '점수 주기 (초)', text: '점령 점수가 들어오는 간격. 개발사가 정한 최소·최대(Min/MaxScorePeriod) 범위로 잘립니다.' },
    },
  },
  '/Script/WDGame.WDGameStateSession': {
    label: '팀 밸런스 · 접속 안내',
    text: '진행 중인 매치는 기존 값을 유지하고 다음 매치 시작 때 읽습니다.',
    keys: {
      bLockOverpopulatedTeamsConfig: { label: '인원 많은 팀 잠금', text: '한 팀이 기준 이상 인원이 많아지면 그 팀으로 합류하지 못하게 막습니다. true/false.' },
      OverpopulatedTeamThresholdConfig: { label: '팀 인원 차이 기준', text: '이만큼 인원이 앞서면 많은 쪽 팀을 잠급니다.' },
      bServerWelcomeMessageEnabled: { label: '접속 안내 팝업 사용', text: '다음 매치부터 접속 안내(서버 규칙) 팝업을 보여 줍니다. True/False.' },
      ServerWelcomeMessageLines: { label: '접속 안내 내용', kind: 'list', text: '처음 배치될 때 한 번 보이는 팝업의 줄. 최대 128줄, 줄당 보이는 글자 128자이고 길면 스크롤됩니다. <Bold> <Italic> <Header> <text color="#RRGGBB" size="8-24" fontface="Bold">로 꾸밀 수 있고, 링크와 다른 태그는 글자 그대로 보입니다. "!...=ClearArray" 다음에 ".ServerWelcomeMessageLines=" 줄을 순서대로 씁니다.' },
      ServerWelcomeMessageCloseDelaySeconds: { label: '팝업 닫기 잠금 (초)', text: '먼저 읽도록 닫기 버튼을 잠그는 시간. 0 = 잠금 없음, 최대 60.' },
      bServerWelcomeMessageSkipForStreamers: { label: '스트리머 모드는 건너뜀', text: '스트리머 모드를 켠 플레이어는 접속 안내 팝업을 보지 않습니다.' },
    },
  },
  '/Script/WDGame.WDServerMapRotationSettings': {
    label: '맵 로테이션',
    text: '적용 즉시 다시 만들어지고 다음 맵 변경부터 쓰입니다.',
    keys: {
      bEnabled: { label: '로테이션 사용', text: '맵 로테이션을 켭니다. true/false.' },
      RotationMode: { label: '순서 방식', text: 'Ordered(순서대로) 또는 Random(무작위).' },
      RotationEntries: { label: '로테이션 항목', kind: 'list', text: '한 줄에 하나. Map=맵 ID, Experience(단수)=모드 하나, Experiences(복수)=\'+\'로 이은 여러 모드(예: Madrid_KOTH_01+KOTH_InfantryOnly). Lighting=허용된 조명. ZoneAlternator는 선택이며, 빼면 맵 기본 점령 구역 순환을 씁니다.' },
    },
  },
  '/Script/WDRCON.WDRCONSettings': {
    label: 'RCON · 이벤트 피드',
    text: '지금 저장되지만 서버 시작 때 읽으므로 재시작해야 적용됩니다.',
    keys: {
      bEnabled: { label: 'RCON 사용', text: 'RCON 관리 리스너를 켭니다. 기본은 꺼짐. 꺼지면 이벤트 피드도 꺼집니다.' },
      BindAddress: { label: '바인드 주소', text: '127.0.0.1 = 이 컴퓨터만(평문 Password 허용). 0.0.0.0 = 모든 인터페이스(TLS 인증서와 PasswordHash 필요).' },
      Port: { label: 'RCON 포트', text: '기본 7776. 여기 또는 실행 인자 "-RCONPort="로 바꿉니다.' },
      Password: { label: 'RCON 비밀번호', text: '평문 비밀번호. 비워 두면 부팅마다 새로 만들어 Saved/RCON/ADMIN-PASSWORD.txt에 씁니다. 외부 접속(비루프백) 서버는 TLS 인증서·키도 있어야 리스너가 켜집니다.' },
      PasswordHash: { label: 'RCON 비밀번호 해시', text: '평문 대신 쓰는 해시. "WardogsServer -GenerateRCONHash=<비밀번호>"로 만듭니다. 둘 다 있으면 이 값이 우선합니다.' },
      bEventFeedEnabled: { label: '이벤트 피드 사용', text: '킬·매치·입퇴장 이벤트를 아래 주소로 보냅니다. 위 bEnabled가 켜져 있어야 하고, 재시작 후 적용됩니다. 0.3.0부터는 채팅 약관에 동의해야 전송됩니다.' },
      EventFeedEndpoints: { label: '피드 받을 주소', kind: 'list', text: '최대 4개. 모든 주소가 모든 이벤트를 받고, 하나가 죽어도 나머지는 늦어지지 않습니다. Token을 넣으면 "Authorization: Bearer <Token>"으로 보냅니다. 플레이어 SteamID가 담기므로 https://를 쓰세요. 이 파일에서만 설정할 수 있고 RCON으로 불러오면 [redacted]로 가려집니다.' },
      EventFeedServerName: { label: '피드 서버 이름', text: '모든 배치에 함께 보내는 이름표. 비우면 보내지 않습니다.' },
    },
  },
  '/Script/HighPingKickRuntime.WDHighPingKickSettings': {
    label: '고핑 킥 (0.3.0)',
    text: '호스팅 업체가 패치로 값을 정하면 이 섹션의 모든 값보다 우선합니다.',
    keys: {
      MaxAveragePingMilliseconds: { label: '평균 핑 한도 (ms)', text: '접속(맵 변경 포함) 약 2분 뒤 평균 핑을 확인해 넘으면 킥합니다. 0 = 끔(기본값), 1100 이상이면 킥하지 않습니다.' },
      bSoftBanKickedPlayers: { label: '킥 후 재접속 막기', text: '핑으로 킥된 플레이어는 맵이 바뀔 때까지 다시 들어올 수 없습니다.' },
      WarmupSeconds: { label: '접속 직후 유예 (초)', text: '접속 뒤 이 시간 동안의 핑은 무시합니다.' },
      StallSeconds: { label: '멈춤 판정 (초)', text: '접속 중인 플레이어에게서 이만큼 패킷이 없으면 멈춤으로 보고 유예를 다시 시작합니다.' },
      MaximumWarmupSeconds: { label: '최대 유예 (초)', text: '멈춤으로 유예가 몇 번 다시 시작되든 접속 뒤 유예는 이 시간을 넘지 않습니다.' },
      MeasurementSeconds: { label: '측정 시간 (초)', text: '판정 전에 모으는 샘플 시간.' },
      SampleIntervalSeconds: { label: '샘플 간격 (초)', text: '핑을 재는 간격. MinimumSampleIntervalSeconds보다 짧아지지 않습니다.' },
      MinimumSampleIntervalSeconds: { label: '최소 샘플 간격 (초)', text: 'SampleIntervalSeconds에 허용되는 가장 짧은 값.' },
      ServerHitchSeconds: { label: '서버 렉 기준 (초)', text: '지난 측정 이후 아주 긴 서버 프레임으로 잃은 시간이 이보다 크면 그 회차는 샘플을 버립니다. 서버 렉을 플레이어 핑으로 오해하지 않게 합니다.' },
    },
  },
  '/Script/BHAFKDetection.BHAFKDetectionSettings': {
    label: 'AFK 킥 (0.3.0)',
    text: '각 플레이어의 AFK 검사가 매치 시작 때 읽으므로 다음 매치부터 적용됩니다.',
    keys: {
      DefaultAFKTimeOutSeconds: { label: 'AFK 킥 시간 (초)', text: '이 시간 동안 움직임이 없으면 킥합니다. 허용 범위는 게임 서버가 확인합니다.' },
    },
  },
};

export interface IniEntry {
  line: number;
  section: string | null;
  key: string | null;
  commented: boolean;
}

export function scanIni(text: string): IniEntry[] {
  const out: IniEntry[] = [];
  let section: string | null = null;
  text.split('\n').forEach((raw, line) => {
    const head = /^\s*\[(.+)\]\s*$/.exec(raw);
    if (head) {
      section = head[1]!;
      out.push({ line, section, key: null, commented: false });
      return;
    }
    const kv = /^\s*(;\s*)?[+\-.!]?([A-Za-z][A-Za-z0-9_]*)\s*=/.exec(raw);
    if (kv) out.push({ line, section, key: kv[2]!, commented: !!kv[1] });
  });
  return out;
}

export function entryAt(entries: IniEntry[], line: number): IniEntry | null {
  const exact = entries.find((e) => e.line === line);
  if (exact) return exact;
  const before = entries.filter((e) => e.line < line).at(-1);
  return before ? { line: -1, section: before.section, key: null, commented: false } : null;
}

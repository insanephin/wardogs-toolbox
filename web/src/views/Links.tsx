import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { LinkRow, OrError, Streamer, Whitelist, WhitelistBan, WhitelistMode } from '../lib/types.ts';
import { useStore, can } from '../lib/store.ts';
import { api, run, errorMessage } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { fmtTime, charCount } from '../lib/format.ts';
import { Card, Empty, useOnAction } from '../components/common.tsx';
import { Spinner } from '../components/spinner.tsx';
import { IconButton } from '../components/iconButton.tsx';
import { faRotateRight } from '@fortawesome/free-solid-svg-icons';

const WHITELIST_LABELS: Record<WhitelistMode, string> = { off: '꺼짐', kick: '미연동 킥', ban: '미연동 밴' };
const MODE_HELP: Record<WhitelistMode, string> = {
  off: '누구나 접속할 수 있습니다.',
  kick: '웹 연동(스팀+치지직)도 화이트리스트 등록(디스코드)도 하지 않은 플레이어를 입장하자마자 킥합니다. 인증 후 바로 다시 들어올 수 있습니다.',
  ban: '웹 연동(스팀+치지직)도 화이트리스트 등록(디스코드)도 하지 않은 플레이어를 밴합니다. 인증하면 자동으로 밴이 풀립니다.',
};

export default function Links() {
  const [links, setLinks] = useState<OrError<LinkRow[]> | null>(null);
  const [wl, setWl] = useState<Whitelist | null>(null);
  const [streamers, setStreamers] = useState<OrError<Streamer[]> | null>(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'viewer' | 'streamer'>('viewer');

  const load = useCallback(async () => {
    try {
      const [l, w] = await Promise.all([api<LinkRow[]>('GET', '/api/links'), api<Whitelist>('GET', '/api/whitelist')]);
      setLinks(l);
      setWl(w);
    } catch (err) {
      setLinks({ error: errorMessage(err) });
    }
    api<Streamer[]>('GET', '/api/streamers').then(setStreamers, (err) => setStreamers({ error: errorMessage(err) }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useOnAction((a) => (a.action.startsWith('whitelist_') || a.action.startsWith('reserved_') || a.action === 'unlink' || a.action === 'streamer_remove') && load());

  const q = search.trim().toLowerCase();
  const hit = (...vals: (string | null | undefined)[]) => !q || vals.some((v) => v && v.toLowerCase().includes(q));
  const streamerList = Array.isArray(streamers) ? streamers : [];
  const streamerIds = new Set(streamerList.map((s) => s.steamId));
  const viewers = (Array.isArray(links) ? links : []).filter((l) => !streamerIds.has(l.steamId));
  const viewerRows = viewers.filter((l) => hit(l.steamId, l.steamName, l.lastName, l.chzzkName, l.chzzkChannelId));
  const streamerRows = streamerList.filter((s) => hit(s.steamId, s.steamName, s.chzzkName, s.chzzkChannelId, s.discordName, s.discordId));
  const loadError = links && !Array.isArray(links) ? links.error : streamers && !Array.isArray(streamers) ? streamers.error : null;

  return (
    <div className="grid-main">
      <Card title="연동된 계정" extra={<IconButton icon={faRotateRight} label="새로고침" onClick={load} />}>
        <div className="toolbar">
          <div className="seg" role="tablist" aria-label="연동 종류">
            <button type="button" role="tab" aria-selected={tab === 'viewer'} className={tab === 'viewer' ? 'on' : ''} onClick={() => setTab('viewer')}>{`시청자 ${viewers.length}`}</button>
            <button type="button" role="tab" aria-selected={tab === 'streamer'} className={tab === 'streamer' ? 'on' : ''} onClick={() => setTab('streamer')}>{`화이트리스트 ${streamerList.length}`}</button>
          </div>
          <input type="search" placeholder={tab === 'viewer' ? '스팀·치지직 이름 또는 ID' : '디스코드·스팀·치지직 이름 또는 ID'} aria-label="연동 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="card-body"><div className="table-wrap">
          {!links || !streamers ? <Empty><Spinner /></Empty>
            : loadError ? <Empty>불러오지 못했습니다: {loadError}</Empty>
              : tab === 'viewer'
                ? (!viewerRows.length ? <Empty>{viewers.length ? '조건에 맞는 계정이 없습니다.' : '아직 연동한 시청자가 없습니다. 연동 페이지(/)를 안내해 주세요.'}</Empty>
                  : <LinkTable rows={viewerRows} onChanged={load} />)
                : (!streamerRows.length ? <Empty>{streamerList.length ? '조건에 맞는 화이트리스트 유저가 없습니다.' : '아직 화이트리스트에 등록한 유저가 없습니다. 디스코드 패널을 안내해 주세요.'}</Empty>
                  : <StreamerTable rows={streamerRows} onChanged={load} />)}
        </div></div>
        <p className="card-foot muted small">{tab === 'viewer'
          ? <>시청자는 <a href="/" className="link">연동 페이지</a>에서 치지직과 스팀에 모두 로그인해야 연동됩니다.</>
          : '화이트리스트는 디스코드에서 스팀(치지직은 선택)으로 등록하며, 모두 예약 슬롯에 자동으로 들어갑니다.'}</p>
      </Card>
      <div className="stack">
        <Card title="화이트리스트 우선 입장"><EntryGateForm /></Card>
        <Card title="맵 종료 후 교대 입장"><TurnoverForm /></Card>
        <Card title="화이트리스트">{wl ? <WhitelistForm wl={wl} onSaved={load} /> : <Empty><Spinner /></Empty>}</Card>
        <Card title="미등록 유저 밴"><div className="card-body"><WhitelistBans list={wl?.bans} /></div></Card>
      </div>
    </div>
  );
}

function LinkTable({ rows, onChanged }: { rows: LinkRow[]; onChanged: () => void }) {
  const online = new Set((useStore((s) => s.live)?.players || []).map((p) => p.steamId));
  const mod = can('mod');
  const unlink = async (l: LinkRow) => {
    const name = l.lastName || l.steamName || l.steamId;
    if (!(await confirmAction('연동 해제', `${name}의 연동을 해제합니다. 화이트리스트가 켜져 있으면 이 플레이어는 다시 등록하기 전까지 서버에 들어올 수 없습니다.`, { confirm: '해제' }))) return;
    if (await run('연동 해제', 'DELETE', `/api/links/${l.steamId}`)) onChanged();
  };
  return (
    <table className="table">
      <thead><tr><th>스팀</th><th>치지직</th><th>연동 시각</th>{mod ? <th /> : null}</tr></thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.steamId}>
            <td>
              <div className="pname">
                {l.lastName || l.steamName}
                {online.has(l.steamId) ? <> <span className="tag tag-hs">접속 중</span></> : null}
              </div>
              <div className="mono muted small">{l.steamId}</div>
            </td>
            <td>
              <a className="link" href={`https://chzzk.naver.com/${l.chzzkChannelId}`} target="_blank" rel="noopener noreferrer">{l.chzzkName || l.chzzkChannelId}</a>
            </td>
            <td className="muted small nowrap">{fmtTime(l.linkedAt)}</td>
            {mod ? <td className="nowrap"><button className="btn btn-sm btn-danger-outline" type="button" onClick={() => unlink(l)}>연동 해제</button></td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function EntryGateForm() {
  const gate = useStore((s) => s.live)?.entryGate;
  const players = useStore((s) => s.live)?.players || [];
  const [threshold, setThreshold] = useState('5');
  const [minutes, setMinutes] = useState('10');
  const [message, setMessage] = useState('');
  const editable = can('admin');
  useEffect(() => {
    if (!gate) return;
    setThreshold(String(gate.threshold));
    setMessage((m) => m || gate.message);
  }, [gate?.threshold, gate?.message]);

  if (!gate) return <Empty><Spinner /></Empty>;
  const viewersOnline = players.filter((p) => p.steamId && !p.streamer).length;

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!gate.active && viewersOnline > 0 && !(await confirmAction('입장 제한 시작',
      `지금 접속 중인 화이트리스트가 아닌 플레이어 ${viewersOnline}명이 바로 킥됩니다.`, { confirm: '시작' }))) return;
    await run('입장 제한', 'PUT', '/api/entry-gate', { active: true, threshold: Number(threshold), minutes: Number(minutes) || 0, message: message.trim() });
  };
  const stop = () => run('입장 제한 해제', 'PUT', '/api/entry-gate', { active: false });

  return (
    <form className="card-body stack" onSubmit={start}>
      {gate.active ? (
        <div className="banner banner-warn" role="status">
          {`입장 제한 중 · 화이트리스트 ${gate.streamersOnline}/${gate.threshold}명 접속${gate.openAt ? ` · ${fmtTime(gate.openAt)}에 자동 해제` : ''}`}
        </div>
      ) : <p className="muted small">{`꺼짐 · 지금 접속 중인 화이트리스트 ${gate.streamersOnline}명`}</p>}
      <p className="muted small">켜 두면 화이트리스트가 아닌 플레이어는 입장하자마자 킥됩니다. 화이트리스트가 정한 인원만큼 들어오거나 시간이 지나면 자동으로 풀립니다.</p>
      <div className="toolbar">
        <label className="field">
          <span className="field-label"><span>화이트리스트 인원</span></span>
          <input type="number" min={1} max={100} value={threshold} disabled={!editable} onChange={(e) => setThreshold(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label"><span>자동 해제 (분, 0은 끄기)</span></span>
          <input type="number" min={0} max={180} value={minutes} disabled={!editable} onChange={(e) => setMinutes(e.target.value)} />
        </label>
      </div>
      <label className="field">
        <span className="field-label"><span>안내 문구 (킥 사유로 보임)</span><span>{`${charCount(message)}/200`}</span></span>
        <textarea rows={2} maxLength={200} value={message} disabled={!editable} onChange={(e) => setMessage(e.target.value)} />
      </label>
      {editable ? (
        <div className="toolbar">
          <button className="btn btn-primary" type="submit" disabled={!message.trim() || !(Number(threshold) >= 1)}>{gate.active ? '설정 변경' : '입장 제한 시작'}</button>
          {gate.active ? <button className="btn" type="button" onClick={stop}>입장 제한 해제</button> : null}
        </div>
      ) : <p className="muted small">변경은 관리자만 할 수 있습니다.</p>}
    </form>
  );
}

function TurnoverForm() {
  const turnover = useStore((s) => s.live)?.turnover;
  const [message, setMessage] = useState('');
  const editable = can('admin');
  useEffect(() => {
    if (turnover) setMessage((m) => m || turnover.message);
  }, [turnover?.message]);

  if (!turnover) return <Empty><Spinner /></Empty>;
  const save = (enabled: boolean) => run('교대 입장', 'PUT', '/api/turnover', { enabled, message: message.trim() });
  const running = turnover.pending > 0 || turnover.blocked > 0;

  return (
    <form className="card-body stack" onSubmit={(e: FormEvent) => { e.preventDefault(); save(turnover.enabled); }}>
      {running ? (
        <div className="banner banner-warn" role="status">
          {`교대 중 · 킥 대기 ${turnover.pending}명 · 재입장 차단 ${turnover.blocked}명${turnover.blockedUntil ? ` (${fmtTime(turnover.blockedUntil)}까지)` : ''}`}
        </div>
      ) : <p className="muted small">{turnover.enabled ? '켜짐 · 다음 매치 종료 화면에서 실행됩니다' : '꺼짐'}</p>}
      <label className="field">
        <span className="field-label"><span>안내 문구 (킥 사유로 보임)</span><span>{`${charCount(message)}/200`}</span></span>
        <textarea rows={2} maxLength={200} value={message} disabled={!editable} onChange={(e) => setMessage(e.target.value)} />
      </label>
      {editable ? (
        <div className="toolbar">
          <button className="btn btn-primary" type="button" disabled={!message.trim()} onClick={() => save(!turnover.enabled)}>{turnover.enabled ? '끄기' : '켜기'}</button>
          {turnover.enabled ? <button className="btn" type="submit" disabled={!message.trim() || message.trim() === turnover.message}>문구 저장</button> : null}
        </div>
      ) : <p className="muted small">변경은 관리자만 할 수 있습니다.</p>}
    </form>
  );
}

function StreamerTable({ rows, onChanged }: { rows: Streamer[]; onChanged: () => void }) {
  const online = new Set((useStore((s) => s.live)?.players || []).map((p) => p.steamId));
  const mod = can('mod');
  const remove = async (s: Streamer) => {
    const name = s.discordName || s.discordId;
    if (!(await confirmAction('화이트리스트 해제', `${name}의 화이트리스트 등록을 해제하고 예약 슬롯에서 뺍니다. 치지직·스팀 연동은 남아 시청자로 바뀝니다.`, { confirm: '해제' }))) return;
    if (await run('화이트리스트 해제', 'DELETE', `/api/streamers/${s.discordId}`)) onChanged();
  };
  return (
    <table className="table">
      <thead><tr><th>디스코드</th><th>스팀</th><th>치지직</th><th>인증 시각</th>{mod ? <th /> : null}</tr></thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.discordId}>
            <td>
              <div className="pname">
                {s.discordName || s.discordId}
                {online.has(s.steamId) ? <> <span className="tag tag-hs">접속 중</span></> : null}
              </div>
              {s.lastError ? <div className="small danger">{`예약 슬롯 등록 재시도 중: ${s.lastError}`}</div> : null}
            </td>
            <td>
              <div>{s.steamName ?? '—'}</div>
              <div className="mono muted small">{s.steamId}</div>
            </td>
            <td>
              {s.chzzkChannelId
                ? <a className="link" href={`https://chzzk.naver.com/${s.chzzkChannelId}`} target="_blank" rel="noopener noreferrer">{s.chzzkName || s.chzzkChannelId}</a>
                : <span className="tag tag-danger">미연동</span>}
            </td>
            <td className="muted small nowrap">{fmtTime(s.linkedAt)}</td>
            {mod ? <td className="nowrap"><button className="btn btn-sm btn-danger-outline" type="button" onClick={() => remove(s)}>화이트리스트 해제</button></td> : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WhitelistForm({ wl, onSaved }: { wl: Whitelist; onSaved: () => void }) {
  const [mode, setMode] = useState(wl.mode);
  const [message, setMessage] = useState(wl.message);
  const editable = can('admin');
  const unlinkedOnline = (useStore((s) => s.live)?.players || []).filter((p) => p.steamId && !p.link && !p.streamer).length;
  const messageEditable = editable && mode !== 'off';
  const dirty = mode !== wl.mode || (messageEditable && message !== wl.message);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (mode !== 'off' && mode !== wl.mode && unlinkedOnline > 0 && !(await confirmAction('화이트리스트 켜기',
      `지금 접속 중인 미연동 플레이어 ${unlinkedOnline}명이 바로 ${mode === 'ban' ? '밴·킥' : '킥'}됩니다.`, { confirm: '적용' }))) return;
    if (await run('화이트리스트', 'PUT', '/api/whitelist', { mode, message: mode === 'off' ? wl.message : message.trim() })) onSaved();
  };

  return (
    <form className="card-body stack" onSubmit={save}>
      <div className="seg" role="radiogroup" aria-label="화이트리스트 모드">
        {(Object.entries(WHITELIST_LABELS) as [WhitelistMode, string][]).map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={mode === id} className={mode === id ? 'on' : ''} disabled={!editable} onClick={() => setMode(id)}>{label}</button>
        ))}
      </div>
      <p className="muted small">{MODE_HELP[mode]}</p>
      <label className="field">
        <span className="field-label"><span>안내 문구 (킥·밴 사유로 플레이어에게 보임)</span><span>{`${charCount(message)}/200`}</span></span>
        <textarea rows={3} maxLength={200} value={mode === 'off' ? wl.message : message} disabled={!messageEditable} onChange={(e) => setMessage(e.target.value)} />
      </label>
      {mode !== 'off' ? <p className="small">{`지금 접속 중인 미연동 플레이어: ${unlinkedOnline}명`}</p> : editable ? <p className="muted small">안내 문구는 킥·밴 모드를 고르면 바꿀 수 있습니다.</p> : null}
      {editable
        ? <div><button className="btn" type="submit" disabled={!dirty || (messageEditable && !message.trim())}>저장</button></div>
        : <p className="muted small">변경은 관리자만 할 수 있습니다.</p>}
      <p className="muted small">대시보드가 켜져 있을 때만 집행됩니다. RCON 제한에 의해 1회 요청마다 최대 3명씩 처리 가능합니다.</p>
    </form>
  );
}

function WhitelistBans({ list }: { list: WhitelistBan[] | undefined }) {
  if (!list) return null;
  if (!list.length) return <Empty>목록이 비어있습니다.</Empty>;
  return (
    <ul className="plain-list">
      {list.map((b) => (
        <li key={b.steamId}>
          <div>{b.name || '—'} <span className="mono muted small">{b.steamId}</span></div>
          <div className="muted small">{`${fmtTime(b.createdAt)}${b.linked ? ' · 연동됨, 곧 해제' : ''}`}</div>
          {b.lastError ? <div className="small danger">해제 실패: {b.lastError}</div> : null}
        </li>
      ))}
    </ul>
  );
}

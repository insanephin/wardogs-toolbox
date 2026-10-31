import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { OrError, Streamer } from '../lib/types.ts';
import { useStore, can } from '../lib/store.ts';
import { api, run, errorMessage } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { fmtTime } from '../lib/format.ts';
import { Card, Empty, useOnAction } from '../components/common.tsx';
import { Spinner } from '../components/spinner.tsx';
import { SortTable } from '../components/sortTable.tsx';
import { IconButton } from '../components/iconButton.tsx';
import { KickMessage } from '../components/kickMessage.tsx';
import { faRotateRight } from '@fortawesome/free-solid-svg-icons';
import { PlayerName } from '../components/playerName.tsx';

export default function Whitelist() {
  const [streamers, setStreamers] = useState<OrError<Streamer[]> | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(() => {
    api<Streamer[]>('GET', '/api/streamers').then(setStreamers, (err) => setStreamers({ error: errorMessage(err) }));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useOnAction((a) => (a.action.startsWith('reserved_') || a.action === 'streamer_remove') && load());

  const q = search.trim().toLowerCase();
  const hit = (...vals: (string | null | undefined)[]) => !q || vals.some((v) => v && v.toLowerCase().includes(q));
  const list = Array.isArray(streamers) ? streamers : [];
  const rows = list.filter((s) => hit(s.steamId, s.steamName, s.chzzkName, s.chzzkChannelId, s.discordName, s.discordId));

  return (
    <div className="grid-main">
      <Card title={`화이트리스트 유저 ${list.length}`} extra={<IconButton icon={faRotateRight} label="새로고침" onClick={load} />}>
        <div className="toolbar">
          <input type="search" placeholder="디스코드·스팀·치지직 이름 또는 ID" aria-label="화이트리스트 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="card-body"><div className="table-wrap">
          {!streamers ? <Empty><Spinner /></Empty>
            : !Array.isArray(streamers) ? <Empty>불러오지 못했습니다: {streamers.error}</Empty>
              : !rows.length ? <Empty>{list.length ? '조건에 맞는 화이트리스트 유저가 없습니다.' : '화이트리스트 유저가 없습니다.'}</Empty>
                : <StreamerTable rows={rows} onChanged={load} />}
        </div></div>
      </Card>
      <div className="stack">
        <Card title="화이트리스트 우선 입장"><EntryGateForm /></Card>
        <Card title="대기자 우선 입장"><TurnoverForm /></Card>
      </div>
    </div>
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
      <KickMessage label="안내 문구 (킥 사유로 보임)" value={message} disabled={!editable} onChange={setMessage} />
      {editable ? (
        <div className="toolbar">
          <button className="btn btn-primary" type="submit" disabled={!message.trim() || !(Number(threshold) >= 1)}>{gate.active ? '설정 변경' : '입장 제한 시작'}</button>
          {gate.active ? <button className="btn" type="button" onClick={stop}>입장 제한 해제</button> : null}
        </div>
      ) : null}
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
      <KickMessage label="안내 문구 (킥 사유로 보임)" value={message} disabled={!editable} onChange={setMessage} />
      {editable ? (
        <div className="toolbar">
          <button className="btn btn-primary" type="button" disabled={!message.trim()} onClick={() => save(!turnover.enabled)}>{turnover.enabled ? '끄기' : '켜기'}</button>
          {turnover.enabled ? <button className="btn" type="submit" disabled={!message.trim() || message.trim() === turnover.message}>문구 저장</button> : null}
        </div>
      ) : null}
    </form>
  );
}

function StreamerTable({ rows, onChanged }: { rows: Streamer[]; onChanged: () => void }) {
  const online = new Set((useStore((s) => s.live)?.players || []).map((p) => p.steamId));
  const mod = can('mod');
  const remove = async (s: Streamer) => {
    const name = s.discordName || s.discordId;
    if (!(await confirmAction('화이트리스트 해제', `${name}의 화이트리스트 등록을 해제하고 예약 슬롯에서 뺍니다. 치지직·스팀 연동은 일반 연동 계정으로 남습니다.`, { confirm: '해제' }))) return;
    if (await run('화이트리스트 해제', 'DELETE', `/api/streamers/${s.discordId}`)) onChanged();
  };
  return (
    <SortTable rows={rows} rowKey={(s) => s.discordId} initial={{ key: 'linkedAt', dir: -1 }} columns={[
      { key: 'discord', label: '디스코드', sort: (s) => s.discordName || s.discordId, render: (s) => (
        <>
          <div className="pname">
            <PlayerName steamId={s.steamId} name={s.steamName}>{s.discordName || s.discordId}</PlayerName>
            {online.has(s.steamId) ? <> <span className="tag tag-hs">접속 중</span></> : null}
          </div>
          {s.lastError ? <div className="small danger">{`예약 슬롯 등록 재시도 중: ${s.lastError}`}</div> : null}
        </>
      ) },
      { key: 'steam', label: '스팀', sort: (s) => s.steamName, render: (s) => (
        <>
          <div>{s.steamName ? <PlayerName className="tag tag-steam" steamId={s.steamId} name={s.steamName} /> : '—'}</div>
          <div className="mono muted small">{s.steamId}</div>
        </>
      ) },
      { key: 'chzzk', label: '치지직', sort: (s) => s.chzzkName || s.chzzkChannelId, render: (s) => (s.chzzkChannelId
        ? <PlayerName className="tag tag-chzzk" steamId={s.steamId} name={s.steamName}>{s.chzzkName || s.chzzkChannelId}</PlayerName>
        : <span className="tag tag-danger">미연동</span>) },
      { key: 'linkedAt', label: '인증 시각', desc: true, sort: (s) => s.linkedAt, className: 'muted small nowrap', render: (s) => fmtTime(s.linkedAt) },
      ...(mod ? [{ key: 'actions', label: <span className="sr-only">작업</span>, className: 'actions', render: (s: Streamer) => (
        <button className="btn btn-sm btn-danger-outline" type="button" onClick={() => remove(s)}>화이트리스트 해제</button>
      ) }] : []),
    ]} />
  );
}

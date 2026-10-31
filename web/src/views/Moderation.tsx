import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Ban, OrError, PendingBan } from '../lib/types.ts';
import { getState, can } from '../lib/store.ts';
import { api, run, errorMessage } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { fmtTime, STEAM_ID } from '../lib/format.ts';
import { toast } from '../lib/toast.ts';
import { Card, Empty, Avatar, useOnAction, useSteamProfiles } from '../components/common.tsx';
import type { SteamProfiles } from '../components/common.tsx';
import { IconButton } from '../components/iconButton.tsx';
import { HoldButton } from '../components/holdButton.tsx';
import { SortTable } from '../components/sortTable.tsx';
import { faRotateRight, faTrash } from '@fortawesome/free-solid-svg-icons';
import { PlayerName } from '../components/playerName.tsx';

interface Bans {
  bans: Ban[];
  pending: PendingBan[];
}

interface Reserved {
  live: string[];
  inDoc: string[] | null;
  streamers: string[];
}

export default function Moderation() {
  const [bans, setBans] = useState<OrError<Bans> | null>(null);
  const [reservedTick, setReservedTick] = useState(0);

  const load = useCallback(async () => {
    try {
      setBans(await api<Bans>('GET', '/api/bans'));
    } catch (err) {
      setBans({ error: errorMessage(err) });
    }
    setReservedTick((n) => n + 1);
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  useOnAction((a) => a.action === 'pending_ban_enforced' && load());

  return (
    <div className="grid-main">
      <Card title="밴 목록" extra={<IconButton icon={faRotateRight} label="새로고침" onClick={load} />}>
        {can('mod') ? <BanForm onDone={load} /> : null}
        <div className="card-body"><div className="table-wrap"><BanTable data={bans} onChange={load} /></div></div>
      </Card>
      <div className="stack">
        <Card title="입장 시 집행 대기"><div className="card-body"><Pending list={bans && bans.error === undefined ? bans.pending : undefined} onChange={load} /></div></Card>
        <Card title="예약 슬롯"><div className="card-body"><Reserved reloadTick={reservedTick} /></div></Card>
      </div>
    </div>
  );
}

function BanForm({ onDone }: { onDone: () => void }) {
  const [steamId, setSteamId] = useState('');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const idRef = useRef<HTMLInputElement>(null);

  const add = async () => {
    const id = steamId.trim();
    if (!STEAM_ID.test(id)) {
      setInvalid(true);
      idRef.current?.focus();
      return;
    }
    setInvalid(false);
    const online = getState().live?.players?.some((p) => p.steamId === id);
    if (!online && !(await confirmAction('접속 중이 아닌 플레이어',
      '게임은 접속한 적 없는 SteamID를 밴 할 수 없습니다.',
      { confirm: '대기열에 등록' }))) return;
    const r = await run('밴', 'POST', '/api/bans', { steamId: id, reason: reason.trim() });
    if (r) {
      setSteamId('');
      setReason('');
      onDone();
    }
  };

  return (
    <form className="toolbar" onSubmit={(e: FormEvent) => e.preventDefault()}>
      <input ref={idRef} className={invalid ? 'invalid' : undefined} placeholder="SteamID64 (17자리)" inputMode="numeric" aria-label="밴할 SteamID" maxLength={17}
        value={steamId} onChange={(e) => setSteamId(e.target.value)} />
      <input placeholder="사유 (선택, 최대 200자)" maxLength={200} aria-label="밴 사유" value={reason} onChange={(e) => setReason(e.target.value)} />
      <HoldButton label="밴 추가" onConfirm={add} />
    </form>
  );
}

function BanTable({ data, onChange }: { data: OrError<Bans> | null; onChange: () => void }) {
  const profiles = useSteamProfiles(data && data.error === undefined ? data.bans.map((b) => b.steamId) : []);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  if (data.error !== undefined) return <Empty>밴 목록을 불러오지 못했습니다: {data.error}</Empty>;
  if (!data.bans.length) return <Empty>목록이 비어있습니다.</Empty>;
  const mod = can('mod');
  const q = search.trim().toLowerCase();
  const rows = data.bans.filter((b) => !q || [b.steamId, b.reason, b.bannedBy, profiles[b.steamId]?.name].some((v) => v?.toLowerCase().includes(q)));
  const chosen = data.bans.filter((b) => picked.has(b.steamId));
  const toggle = (id: string, on: boolean) => setPicked((p) => {
    const next = new Set(p);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  const allShown = rows.length > 0 && rows.every((b) => picked.has(b.steamId));

  const unban = async (b: Ban) => {
    if (!(await confirmAction('밴 해제', `${b.steamId}의 밴을 해제합니다.`, { danger: false, confirm: '해제' }))) return;
    await run('밴 해제', 'DELETE', `/api/bans/${b.steamId}`);
    onChange();
  };
  const unbanPicked = async () => {
    if (!(await confirmAction('선택 밴 해제', `${chosen.length}명의 밴을 해제합니다.`, { danger: false, confirm: '해제' }))) return;
    setBusy(true);
    let done = 0;
    for (const b of chosen) if (await run('밴 해제', 'DELETE', `/api/bans/${b.steamId}`)) done++;
    setBusy(false);
    setPicked(new Set());
    toast(`${chosen.length}명 중 ${done}명의 밴을 해제했습니다`, done === chosen.length ? 'ok' : 'warn');
    onChange();
  };

  return (
    <div className="stack">
      <div className="toolbar">
        <input type="search" placeholder="SteamID, 이름, 사유, 처리자" aria-label="밴 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
        {mod ? <button className="btn" type="button" disabled={busy || !chosen.length} onClick={unbanPicked}>{`선택 해제 (${chosen.length})`}</button> : null}
      </div>
      {!rows.length ? <Empty>조건에 맞는 밴이 없습니다.</Empty> : (
        <SortTable rows={rows} rowKey={(b) => b.steamId} columns={[
          ...(mod ? [{ key: 'pick', label: (
            <input type="checkbox" aria-label="보이는 밴 모두 선택" checked={allShown} onChange={(e) => setPicked((p) => {
              const next = new Set(p);
              for (const b of rows) if (e.target.checked) next.add(b.steamId); else next.delete(b.steamId);
              return next;
            })} />
          ), render: (b: Ban) => <input type="checkbox" aria-label={`${b.steamId} 선택`} checked={picked.has(b.steamId)} onChange={(e) => toggle(b.steamId, e.target.checked)} /> }] : []),
          { key: 'player', label: '플레이어', sort: (b) => profiles[b.steamId]?.name ?? b.steamId, render: (b) => <SteamWho id={b.steamId} profiles={profiles} /> },
          { key: 'at', label: '일시', desc: true, sort: (b) => (b.bannedAtUtc?.startsWith('0001') ? 0 : Date.parse(b.bannedAtUtc ?? '') || null), render: (b) => (b.bannedAtUtc?.startsWith('0001') ? '설정 파일' : fmtTime(Date.parse(b.bannedAtUtc ?? ''))) },
          { key: 'by', label: '처리자', sort: (b) => b.bannedBy, render: (b) => b.bannedBy || '—' },
          { key: 'reason', label: '사유', sort: (b) => b.reason, render: (b) => b.reason || <span className="muted">—</span> },
          { key: 'actions', label: <span className="sr-only">작업</span>, className: 'actions', render: (b) => (mod ? <button className="btn btn-sm" type="button" disabled={busy} onClick={() => unban(b)}>해제</button> : null) },
        ]} />
      )}
    </div>
  );
}

function Pending({ list, onChange }: { list: PendingBan[] | undefined; onChange: () => void }) {
  const cancel = async (b: PendingBan) => {
    await run('대기열 삭제', 'DELETE', `/api/pending-bans/${b.steam_id}`);
    onChange();
  };
  return (
    <>
      {list?.length ? (
        <div className="table-wrap">
          <SortTable rows={list} rowKey={(b) => b.steam_id} initial={{ key: 'at', dir: -1 }} columns={[
            { key: 'id', label: 'SteamID', sort: (b) => b.steam_id, className: 'mono', render: (b) => b.steam_id },
            { key: 'reason', label: '사유', sort: (b) => b.reason, className: 'small', render: (b) => (
              <>
                {b.reason || <span className="muted">—</span>}
                {b.last_error ? <div className="danger">마지막 시도 실패: {b.last_error}</div> : null}
              </>
            ) },
            { key: 'by', label: '등록', sort: (b) => b.created_by, className: 'small', render: (b) => b.created_by },
            { key: 'at', label: '일시', desc: true, sort: (b) => b.created_at, className: 'muted small nowrap', render: (b) => fmtTime(b.created_at) },
            ...(can('mod') ? [{ key: 'actions', label: <span className="sr-only">작업</span>, className: 'actions', render: (b: PendingBan) => (
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => cancel(b)}>취소</button>
            ) }] : []),
          ]} />
        </div>
      ) : list ? <Empty>대기 중인 밴이 없습니다.</Empty> : null}
    </>
  );
}

function Reserved({ reloadTick }: { reloadTick: number }) {
  const [data, setData] = useState<OrError<Reserved> | null>(null);
  const [input, setInput] = useState('');
  const [invalid, setInvalid] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api<Reserved>('GET', '/api/reserved'));
    } catch (err) {
      setData({ error: errorMessage(err) });
    }
  }, []);
  useEffect(() => {
    if (reloadTick) load();
  }, [reloadTick, load]);

  const profiles = useSteamProfiles(data && data.error === undefined ? [...data.live, ...(data.inDoc || [])] : []);
  const preview = useSteamProfiles(STEAM_ID.test(input.trim()) ? [input.trim()] : []);
  if (!data) return null;
  if (data.error !== undefined) return <Empty>불러오지 못했습니다: {data.error}</Empty>;

  const live = new Set(data.live);
  const doc = data.inDoc ? new Set(data.inDoc) : null;
  const streamers = new Set(data.streamers);
  const all = [...new Set([...data.live, ...(data.inDoc || [])])];
  const badge = (id: string) => {
    if (!doc) return null;
    if (doc.has(id) && !live.has(id)) return <span className="tag">재시작 후 적용</span>;
    if (!doc.has(id) && live.has(id)) return <span className="tag tag-danger">재시작 후 제외</span>;
    return null;
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!STEAM_ID.test(input.trim())) return setInvalid(true);
    setInvalid(false);
    const r = await run('예약 슬롯 추가', 'POST', '/api/reserved', { steamId: input.trim() });
    if (r) {
      setInput('');
      load();
    }
  };
  const remove = async (id: string) => {
    if (!(await confirmAction('예약 슬롯 삭제', `${id}를 예약 슬롯에서 뺍니다.`, { danger: false, confirm: '삭제' }))) return;
    await run('예약 슬롯 삭제', 'DELETE', `/api/reserved/${id}`);
    load();
  };

  return (
    <>
      {can('admin') ? (
        <>
        <form className="toolbar" onSubmit={add}>
          <input className={invalid ? 'invalid' : undefined} placeholder="SteamID64" inputMode="numeric" maxLength={17} aria-label="예약 슬롯에 추가할 SteamID"
            value={input} onChange={(e) => setInput(e.target.value)} />
          <button className="btn" type="submit">추가</button>
        </form>
        {preview[input.trim()] ? <SteamWho id={input.trim()} profiles={preview} /> : null}
        </>
      ) : null}
      {all.length ? (
        <div className="table-wrap">
          <SortTable rows={all} rowKey={(id) => id} columns={[
            { key: 'player', label: '플레이어', sort: (id) => profiles[id]?.name ?? id, render: (id) => <SteamWho id={id} profiles={profiles} /> },
            { key: 'kind', label: '구분', sort: (id) => (streamers.has(id) ? '화이트리스트' : ''), render: (id) => (
              <span className="inline-row">{streamers.has(id) ? <span className="tag tag-streamer">화이트리스트</span> : null}{badge(id)}</span>
            ) },
            { key: 'actions', label: <span className="sr-only">작업</span>, className: 'actions', render: (id) => (
              can('admin') && !streamers.has(id) && (!doc || doc.has(id)) ? <IconButton icon={faTrash} label="삭제" className="btn-ghost" onClick={() => remove(id)} /> : null
            ) },
          ]} />
        </div>
      ) : <Empty>예약 슬롯이 비어 있습니다.</Empty>}
    </>
  );
}

function SteamWho({ id, profiles }: { id: string; profiles: SteamProfiles }) {
  const p = profiles[id];
  return (
    <span className="who">
      <Avatar src={p?.avatar} />
      <span>{p?.name ? <PlayerName className="pname" steamId={id} name={p.name} /> : null}<span className="mono muted small">{id}</span></span>
    </span>
  );
}

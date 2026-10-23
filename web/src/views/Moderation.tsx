import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Ban, OrError, PendingBan } from '../lib/types.ts';
import { getState, can } from '../lib/store.ts';
import { api, run, errorMessage } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { fmtTime } from '../lib/format.ts';
import { toast } from '../lib/toast.ts';
import { Card, Empty, Avatar, useOnAction, useSteamProfiles } from '../components/common.tsx';
import type { SteamProfiles } from '../components/common.tsx';
import { IconButton } from '../components/iconButton.tsx';
import { faRotateRight, faTrash } from '@fortawesome/free-solid-svg-icons';

const STEAM_ID = /^\d{17}$/;

interface Bans {
  bans: Ban[];
  pending: PendingBan[];
}

interface Reserved {
  live: string[];
  inDoc: string[] | null;
  liveRoutes: boolean;
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

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
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
    <form className="toolbar" onSubmit={onSubmit}>
      <input ref={idRef} className={invalid ? 'invalid' : undefined} placeholder="SteamID64 (17자리)" inputMode="numeric" aria-label="밴할 SteamID" maxLength={17}
        value={steamId} onChange={(e) => setSteamId(e.target.value)} />
      <input placeholder="사유 (선택, 최대 200자)" maxLength={200} aria-label="밴 사유" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn btn-danger" type="submit">밴 추가</button>
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
        <table className="table">
          <thead><tr>
            {mod ? <th><input type="checkbox" aria-label="보이는 밴 모두 선택" checked={allShown} onChange={(e) => setPicked((p) => {
              const next = new Set(p);
              for (const b of rows) if (e.target.checked) next.add(b.steamId); else next.delete(b.steamId);
              return next;
            })} /></th> : null}
            <th>플레이어</th><th>일시</th><th>처리자</th><th>사유</th><th><span className="sr-only">작업</span></th>
          </tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.steamId}>
                {mod ? <td><input type="checkbox" aria-label={`${b.steamId} 선택`} checked={picked.has(b.steamId)} onChange={(e) => toggle(b.steamId, e.target.checked)} /></td> : null}
                <td><SteamWho id={b.steamId} profiles={profiles} /></td>
                <td>{b.bannedAtUtc?.startsWith('0001') ? '설정 파일' : fmtTime(Date.parse(b.bannedAtUtc ?? ''))}</td>
                <td>{b.bannedBy || '—'}</td>
                <td>{b.reason || <span className="muted">—</span>}</td>
                <td className="actions">{mod ? <button className="btn btn-sm" type="button" disabled={busy} onClick={() => unban(b)}>해제</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
      <p className="muted small">게임은 접속 중인 플레이어만 밴할 수 있어서, 오프라인 밴은 대기자 목록에 추가 후 입장 순간 집행됩니다.</p>
      {list?.length ? (
        <ul className="plain-list">
          {list.map((b) => (
            <li key={b.steam_id}>
              <div><span className="mono">{b.steam_id}</span> <span className="muted small">{`${b.created_by} · ${fmtTime(b.created_at)}`}</span></div>
              {b.reason ? <div className="small">{b.reason}</div> : null}
              {b.last_error ? <div className="small danger">마지막 시도 실패: {b.last_error}</div> : null}
              {can('mod') ? <button className="btn btn-ghost btn-sm" type="button" onClick={() => cancel(b)}>취소</button> : null}
            </li>
          ))}
        </ul>
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
      <p className="muted small">
        {data.liveRoutes
          ? '이 빌드는 예약 슬롯을 바로 편집할 수 있습니다.'
          : '현재 빌드는 예약 슬롯 편집 경로가 없어 설정 문서(DefaultReservedPlayerIds)를 고쳐 적용합니다. 실행 중인 서버는 재시작 때 목록을 다시 읽습니다.'}
      </p>
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
        <ul className="plain-list">
          {all.map((id) => (
            <li key={id} className="row-between">
              <span className="inline-row"><SteamWho id={id} profiles={profiles} />{streamers.has(id) ? <span className="tag tag-streamer">화이트리스트</span> : null}{badge(id)}</span>
              {can('admin') && !streamers.has(id) && (!doc || doc.has(id)) ? <IconButton icon={faTrash} label="삭제" className="btn-ghost" onClick={() => remove(id)} /> : null}
            </li>
          ))}
        </ul>
      ) : <Empty>예약 슬롯이 비어 있습니다.</Empty>}
      <p className="muted small">화이트리스트 슬롯은 자동으로 유지됩니다. 빼려면 연동 탭에서 화이트리스트를 해제하세요.</p>
      <p className="muted small">MaxReservedSlots는 비워 두는 자리 수이고, 목록에 있는 사람은 수와 상관없이 대기열을 건너뜁니다.</p>
    </>
  );
}

function SteamWho({ id, profiles }: { id: string; profiles: SteamProfiles }) {
  const p = profiles[id];
  return (
    <span className="who">
      <Avatar src={p?.avatar} />
      <span>{p?.name ? <span className="pname">{p.name}</span> : null}<span className="mono muted small">{id}</span></span>
    </span>
  );
}

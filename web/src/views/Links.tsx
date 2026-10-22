import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { LinkRow, OrError, Whitelist, WhitelistBan, WhitelistMode } from '../lib/types.ts';
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
  kick: '스팀과 치지직을 모두 연동하지 않은 플레이어를 입장하자마자 킥합니다. 연동 후 바로 다시 들어올 수 있습니다.',
  ban: '스팀과 치지직을 모두 연동하지 않은 플레이어를 밴합니다. 안내 후 연동할 경우 자동으로 밴이 풀립니다.',
};

export default function Links() {
  const [links, setLinks] = useState<OrError<LinkRow[]> | null>(null);
  const [wl, setWl] = useState<Whitelist | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    try {
      const [l, w] = await Promise.all([api<LinkRow[]>('GET', '/api/links'), api<Whitelist>('GET', '/api/whitelist')]);
      setLinks(l);
      setWl(w);
    } catch (err) {
      setLinks({ error: errorMessage(err) });
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useOnAction((a) => (a.action.startsWith('whitelist_') || a.action === 'unlink') && load());

  const q = search.trim().toLowerCase();
  const all = Array.isArray(links) ? links : [];
  const rows = all.filter((l) => !q || [l.steamId, l.steamName, l.lastName, l.chzzkName, l.chzzkChannelId]
    .some((v) => v && String(v).toLowerCase().includes(q)));

  return (
    <div className="grid-main">
      <Card title="연동된 계정" extra={<IconButton icon={faRotateRight} label="새로고침" onClick={load} />}>
        <div className="toolbar">
          <input type="search" placeholder="스팀·치지직 이름 또는 ID" aria-label="연동 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="card-body"><div className="table-wrap">
          {!links ? <Empty><Spinner /></Empty>
            : links.error ? <Empty>불러오지 못했습니다: {links.error}</Empty>
              : !rows.length ? <Empty>{all.length ? '조건에 맞는 계정이 없습니다.' : '아직 연동한 사람이 없습니다. 플레이어에게 연동 페이지(/)를 안내해 주세요.'}</Empty>
                : <LinkTable rows={rows} onChanged={load} />}
        </div></div>
        <p className="card-foot muted small">플레이어가 <a href="/" className="link">연동 페이지</a>에서 치지직과 스팀에 모두 로그인해야 연동됩니다.</p>
      </Card>
      <div className="stack">
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

function WhitelistForm({ wl, onSaved }: { wl: Whitelist; onSaved: () => void }) {
  const [mode, setMode] = useState(wl.mode);
  const [message, setMessage] = useState(wl.message);
  const editable = can('admin');
  const unlinkedOnline = (useStore((s) => s.live)?.players || []).filter((p) => p.steamId && !p.link).length;
  const dirty = mode !== wl.mode || message !== wl.message;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (mode !== 'off' && mode !== wl.mode && unlinkedOnline > 0 && !(await confirmAction('화이트리스트 켜기',
      `지금 접속 중인 미연동 플레이어 ${unlinkedOnline}명이 바로 ${mode === 'ban' ? '밴·킥' : '킥'}됩니다.`, { confirm: '적용' }))) return;
    if (await run('화이트리스트', 'PUT', '/api/whitelist', { mode, message: message.trim() })) onSaved();
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
        <textarea rows={3} maxLength={200} value={message} disabled={!editable} onChange={(e) => setMessage(e.target.value)} />
      </label>
      {mode !== 'off' ? <p className="small">{`지금 접속 중인 미연동 플레이어: ${unlinkedOnline}명`}</p> : null}
      {editable
        ? <div><button className="btn" type="submit" disabled={!dirty || !message.trim()}>저장</button></div>
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

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage } from '../lib/api.ts';
import type { LinkRow, OrError, Whitelist, WhitelistBan, WhitelistMode } from '../lib/types.ts';
import { useStore, can } from '../lib/store.ts';
import { api, run } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { fmtTime, charCount } from '../lib/format.ts';
import { Card, Empty, useOnAction } from '../components/common.tsx';

const WHITELIST_LABELS: Record<WhitelistMode, string> = { off: '꺼짐', kick: '미연동 킥', ban: '미연동 밴' };
const MODE_HELP: Record<WhitelistMode, string> = {
  off: '누구나 접속할 수 있습니다.',
  kick: '스팀을 연동하지 않은 플레이어를 입장하자마자 킥합니다. 연동 후 바로 다시 들어올 수 있습니다.',
  ban: '스팀을 연동하지 않은 플레이어를 밴하고 킥합니다. 연동하면 대시보드가 자동으로 밴을 풉니다. 이 모드를 끄면 미등록 유저 밴도 모두 풀립니다.',
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
  useOnAction((a) => a.action.startsWith('whitelist_') && load());

  const q = search.trim().toLowerCase();
  const all = Array.isArray(links) ? links : [];
  const rows = all.filter((l) => !q || [l.discordName, l.discordId, l.steamId, l.steamName, l.lastName, l.chzzkName]
    .some((v) => v && String(v).toLowerCase().includes(q)));

  return (
    <div className="grid-main">
      <Card title="연동된 계정" extra={<button className="btn btn-sm" type="button" onClick={load}>새로고침</button>}>
        <div className="toolbar">
          <input type="search" placeholder="디스코드·스팀·치지직 이름 또는 ID" aria-label="연동 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="card-body"><div className="table-wrap">
          {!links ? <Empty>불러오는 중…</Empty>
            : links.error ? <Empty>불러오지 못했습니다: {links.error}</Empty>
              : !rows.length ? <Empty>{all.length ? '조건에 맞는 계정이 없습니다.' : '아직 연동한 사람이 없습니다. 디스코드에서 /연동패널을 만들어 주세요.'}</Empty>
                : <LinkTable rows={rows} />}
        </div></div>
        <p className="card-foot muted small">디스코드 봇의 연동 패널로 등록됩니다. 연동 해제도 본인이 디스코드에서 합니다.</p>
      </Card>
      <div className="stack">
        <Card title="화이트리스트">{wl ? <WhitelistForm wl={wl} onSaved={load} /> : <Empty>불러오는 중…</Empty>}</Card>
        <Card title="미등록 유저 밴"><div className="card-body"><WhitelistBans list={wl?.bans} /></div></Card>
      </div>
    </div>
  );
}

function LinkTable({ rows }: { rows: LinkRow[] }) {
  const online = new Set((useStore((s) => s.live)?.players || []).map((p) => p.steamId));
  return (
    <table className="table">
      <thead><tr><th>디스코드</th><th>스팀</th><th>치지직</th></tr></thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.discordId}>
            <td><div className="pname">{l.discordName || '—'}</div><div className="mono muted small">{l.discordId}</div></td>
            <td>
              {l.steamId ? (
                <>
                  <div className="pname">
                    {l.lastName || l.steamName}
                    {online.has(l.steamId) ? <> <span className="tag tag-hs">접속 중</span></> : null}
                  </div>
                  <div className="mono muted small">{l.steamId}</div>
                </>
              ) : <span className="muted">미연동</span>}
            </td>
            <td>
              {l.chzzkChannelId ? (
                <a className="link" href={`https://chzzk.naver.com/${l.chzzkChannelId}`} target="_blank" rel="noopener noreferrer">{l.chzzkName || l.chzzkChannelId}</a>
              ) : <span className="muted">미연동</span>}
            </td>
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
      <p className="muted small">대시보드가 켜져 있을 때만 집행됩니다. RCON 한도를 지키려고 한 번에 최대 3명씩, 몇 초 간격으로 처리합니다.</p>
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

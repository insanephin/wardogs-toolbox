import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useStore, can } from '../lib/store.ts';
import { api, errorMessage, refreshMe } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { toast } from '../lib/toast.ts';
import { fmtTime, STEAM_ID } from '../lib/format.ts';
import { Card, PageActions, Empty, Avatar } from '../components/common.tsx';
import { Spinner } from '../components/spinner.tsx';
import { SortTable } from '../components/sortTable.tsx';
import type { Member, Role } from '../lib/types.ts';
import { ROLE_LABEL } from '../lib/labels.ts';

const ROLES: Role[] = ['viewer', 'mod', 'admin', 'owner'];

export default function Members() {
  const me = useStore((s) => s.me);
  const owner = can('owner');
  const [list, setList] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const [steamId, setSteamId] = useState('');
  const [role, setRole] = useState<Role>('mod');

  useEffect(() => {
    api<Member[]>('GET', '/api/members').then(setList, (err) => setError(errorMessage(err)));
  }, []);

  const save = async (id: string, r: Role, label: string) => {
    try {
      setList(await api<Member[]>('PUT', `/api/members/${id}`, { role: r }));
      toast(`${label} 완료`);
      if (id === me?.steamId) refreshMe();
      return true;
    } catch (err) {
      toast(`${label} 실패: ${errorMessage(err)}`, 'error');
      return false;
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await save(steamId.trim(), role, '관리자 추가')) setSteamId('');
  };
  const remove = async (m: Member) => {
    if (!(await confirmAction('관리자 빼기', `${m.name ?? m.steamId}을(를) 이 서버에서 뺍니다. 바로 패널 접근이 막힙니다.`, { confirm: '빼기' }))) return;
    try {
      setList(await api<Member[]>('DELETE', `/api/members/${m.steamId}`));
      toast('관리자를 뺐습니다');
      if (m.steamId === me?.steamId) refreshMe();
    } catch (err) {
      toast(`관리자 빼기 실패: ${errorMessage(err)}`, 'error');
    }
  };

  return (
    <Card>
      {list ? <PageActions><span className="muted small">{list.length}명</span></PageActions> : null}
      <div className="card-body stack">
        {owner ? (
          <form className="inline-field add-member" onSubmit={add}>
            <input aria-label="추가할 SteamID64" inputMode="numeric" placeholder="SteamID64 (17자리)" maxLength={17} value={steamId}
              onChange={(e) => setSteamId(e.target.value.replace(/\D/g, ''))} />
            <select aria-label="권한" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
            </select>
            <button className="btn" type="submit" disabled={!STEAM_ID.test(steamId.trim())}>추가</button>
          </form>
        ) : null}
        {error ? <Empty>불러오지 못했습니다: {error}</Empty> : !list ? <Spinner /> : !list.length ? <Empty>아직 관리자가 없습니다.</Empty> : (
          <div className="table-wrap">
            <SortTable rows={list} rowKey={(m) => m.steamId} initial={{ key: 'role', dir: -1 }} columns={[
              { key: 'name', label: '스팀', sort: (m) => m.name, render: (m) => (
                <>
                  <div className="pname"><Avatar src={m.avatar} />{m.name ?? '이름 모름'}</div>
                  <div className="mono muted small">{m.steamId}</div>
                </>
              ) },
              { key: 'role', label: '권한', desc: true, sort: (m) => ROLES.indexOf(m.role), className: 'nowrap', render: (m) => owner ? (
                <select aria-label={`${m.name ?? m.steamId} 권한`} value={m.role} onChange={(e) => save(m.steamId, e.target.value as Role, '권한 변경')}>
                  {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              ) : ROLE_LABEL[m.role] },
              { key: 'addedAt', label: '추가', desc: true, sort: (m) => m.addedAt, className: 'muted small nowrap', render: (m) => fmtTime(m.addedAt) },
              { key: 'lastLoginAt', label: '마지막 로그인', desc: true, sort: (m) => m.lastLoginAt, className: 'muted small nowrap', render: (m) => (m.lastLoginAt ? fmtTime(m.lastLoginAt) : '없음') },
              ...(owner ? [{ key: 'actions', label: <span className="sr-only">작업</span>, className: 'actions', render: (m: Member) => (
                <button className="btn btn-sm btn-danger-outline" type="button" onClick={() => remove(m)}>빼기</button>
              ) }] : []),
            ]} />
          </div>
        )}
      </div>
    </Card>
  );
}

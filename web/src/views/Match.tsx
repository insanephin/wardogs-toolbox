import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Catalog, CatalogItem, MapOptions, OrError, Rotation as RotationData, ScorePeriod } from '../lib/types.ts';
import { useStore, getState, can, serves } from '../lib/store.ts';
import { api, run, errorMessage } from '../lib/api.ts';
import { confirmAction } from '../lib/modal.tsx';
import { Card, Empty, MapArt } from '../components/common.tsx';
import { Spinner } from '../components/spinner.tsx';
import { IconButton } from '../components/iconButton.tsx';
import { faArrowUp, faArrowDown, faTrash, faForwardStep } from '@fortawesome/free-solid-svg-icons';

const pick = (list: CatalogItem[], want: string | undefined): string => (want && list.some((x) => x.id === want) ? want : list[0]?.id ?? '');

const ZONE_BASE = { control: 200, hot: 400 };
const SCORE_BANDS: [number, number, number][] = [[18, 20, 0.6], [21, 23, 0.7], [24, 26, 0.8], [27, 29, 0.9], [30, 30, 1]];
const bandOf = (s: number): [number, number, number] => SCORE_BANDS.find(([lo, hi]) => s >= lo && s <= hi) ?? [s, s, 1];

export default function Match() {
  const admin = can('admin');
  const [catalog, setCatalog] = useState<OrError<Catalog> | null>(null);
  const [rotationRev, setRotationRev] = useState(0);
  const bumpRotation = () => setRotationRev((n) => n + 1);

  useEffect(() => {
    api<Catalog>('GET', '/api/catalog').then(setCatalog, (err) => setCatalog({ error: errorMessage(err) }));
  }, []);

  const ready = catalog && catalog.error === undefined ? catalog : null;
  return (
    <>
      {!admin ? <div className="banner banner-info">경기 운영은 관리자 권한이 필요합니다. 현재 상태와 로테이션만 볼 수 있습니다.</div> : null}
      <div className="grid-main">
        <Card title="맵·조명">
          <div className="card-body stack">
            {catalog?.error ? <Empty>카탈로그를 불러오지 못했습니다: {catalog.error}</Empty> : ready ? (
              <>
                <ChangeMap catalog={ready} admin={admin} rev={rotationRev} onRotationChange={bumpRotation} />
                <LiveLighting catalog={ready} admin={admin} />
              </>
            ) : null}
          </div>
        </Card>
        <Card title="매치 진행">
          <div className="card-body stack">{ready ? <Controls admin={admin} /> : null}</div>
        </Card>
      </div>
      <Card title="맵 로테이션"><div className="card-body stack">{ready ? <Rotation rev={rotationRev} admin={admin} onChange={bumpRotation} /> : null}</div></Card>
    </>
  );
}

function ChangeMap({ catalog, admin, rev, onRotationChange }: { catalog: Catalog; admin: boolean; rev: number; onRotationChange: () => void }) {
  const caps = useStore((s) => s.caps);
  const canEditRotation = admin && (caps?.features?.configDocument ?? true);
  const [map, setMap] = useState(() => pick(catalog.maps, getState().live?.status?.map));
  const [details, setDetails] = useState<MapOptions | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [alternator, setAlternator] = useState('');
  const [lighting, setLighting] = useState('');
  const [rotationOn, setRotationOn] = useState<boolean | null>(null);
  useEffect(() => {
    api<RotationData>('GET', '/api/rotation').then((r) => setRotationOn(!!r.enabled), () => setRotationOn(null));
  }, [rev]);

  useEffect(() => {
    let stale = false;
    setDetails(null);
    api<MapOptions>('GET', `/api/catalog/maps/${encodeURIComponent(map)}`)
      .catch((): MapOptions => ({ experiences: [], alternators: [] }))
      .then((d) => {
        if (stale) return;
        setDetails(d);
        setChecked(d.experiences.slice(0, 1));
        setAlternator('');
      });
    return () => {
      stale = true;
    };
  }, [map]);

  const expLabel = (id: string) => catalog.experiences.find((x) => x.id === id)?.displayName || id;
  const mapLabel = (id: string) => {
    const m = catalog.maps.find((x) => x.id === id);
    return m ? `${m.displayName} (${m.id})` : id;
  };
  const toggle = (id: string, on: boolean) => setChecked((c) => (on ? [...c, id] : c.filter((x) => x !== id)));

  const selection = () => ({
    map,
    experiences: (details?.experiences || []).filter((id) => checked.includes(id)),
    lighting: lighting || undefined,
    zoneAlternator: alternator || undefined,
  });

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!(await confirmAction('맵 변경', `${mapLabel(map)}(으)로 변경합니다. 진행 중인 매치가 끝납니다.`, { confirm: '변경' }))) return;
    await run('맵 변경', 'POST', '/api/match/map', selection());
  };
  const toRotation = async (label: string, path: string) => {
    if (await run(label, 'POST', path, selection())) onRotationChange();
  };

  return (
    <form className="stack" onSubmit={onSubmit}>
      <MapArt map={map} lighting={lighting} variant="720" />
      <label className="field">
        <span className="field-label">맵</span>
        <select aria-label="맵" value={map} onChange={(e) => setMap(e.target.value)}>
          {catalog.maps.map((m) => <option key={m.id} value={m.id}>{mapLabel(m.id)}</option>)}
        </select>
      </label>
      <div className="field">
        <span className="field-label">모드·수정자</span>
        <div className="checks">
          {details ? details.experiences.map((id) => (
            <label key={id} className="check">
              <input type="checkbox" value={id} checked={checked.includes(id)} onChange={(e) => toggle(id, e.target.checked)} />
              <span>{expLabel(id)}</span>
            </label>
          )) : <Empty><Spinner /></Empty>}
        </div>
      </div>
      <div className="grid-2 grid-tight">
        <label className="field">
          <span className="field-label">존 교대</span>
          <select aria-label="존 교대" value={alternator} onChange={(e) => setAlternator(e.target.value)}>
            <option value="">기본값</option>
            {(details?.alternators || []).map((a) => <option key={a.tag} value={a.tag}>{a.displayName || a.tag}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">조명</span>
          <select aria-label="조명" value={lighting} onChange={(e) => setLighting(e.target.value)}>
            <option value="">기본값</option>
            {catalog.lightings.map((l) => <option key={l.id} value={l.id}>{l.displayName || l.id}</option>)}
          </select>
        </label>
      </div>
      <p className="muted small">현재 매치가 끝나는 화면이 지나면 이동합니다. 전환 후 약 40초간 팀 정보가 비어 보입니다.</p>
      <div className="row-wrap">
        <button className="btn btn-primary" type="submit" disabled={!admin}>맵 변경</button>
        <button className="btn" type="button" disabled={!canEditRotation || rotationOn === false}
          title={rotationOn === false ? '로테이션이 꺼져 있어 매치가 끝나면 지금 맵을 다시 불러옵니다' : '현재 맵이 끝나면 이 맵으로 넘어갑니다'}
          onClick={() => toRotation('다음 맵 예약', '/api/rotation/next')}>다음 맵으로 예약</button>
        <button className="btn" type="button" disabled={!canEditRotation}
          onClick={() => toRotation('로테이션 추가', '/api/rotation')}>로테이션 끝에 추가</button>
      </div>
      {rotationOn === false ? <p className="hint">로테이션이 꺼져 있어 다음 맵 예약은 쓸 수 없습니다. 매치가 끝나면 지금 맵을 다시 불러옵니다.</p> : null}
    </form>
  );
}

function LiveLighting({ catalog, admin }: { catalog: Catalog; admin: boolean }) {
  const caps = useStore((s) => s.caps);
  const [lighting, setLighting] = useState(() => pick(catalog.lightings, getState().live?.status?.lighting));
  return (
    <label className="field divider">
      <span className="field-label">조명·날씨 즉시 변경</span>
      <span className="inline-field">
        <select aria-label="실시간 조명" value={lighting} onChange={(e) => setLighting(e.target.value)}>
          {catalog.lightings.map((l) => <option key={l.id} value={l.id}>{l.displayName || l.id}</option>)}
        </select>
        <button className="btn ctl-btn" type="button" disabled={!admin || !serves(caps, 'PUT /v1/world/lighting')}
          onClick={() => run('조명 변경', 'POST', '/api/world/lighting', { lighting })}>적용</button>
      </span>
      <span className="hint">맵을 바꾸지 않고 지금 매치의 조명·날씨만 바꿉니다.</span>
    </label>
  );
}

function Controls({ admin }: { admin: boolean }) {
  const endMatch = async () => {
    if (await confirmAction('매치 종료', '현재 매치를 즉시 끝냅니다. 플레이어 전원에게 영향을 줍니다.', { confirm: '종료' })) await run('매치 종료', 'POST', '/api/match/end', {});
  };
  const restartMatch = async () => {
    if (await confirmAction('매치 재시작', '현재 매치를 처음부터 다시 시작합니다. 점수가 초기화됩니다.', { confirm: '재시작' })) await run('매치 재시작', 'POST', '/api/match/restart', {});
  };

  return (
    <>
      <TickTimer admin={admin} />
      <div className="row-between divider">
        <div><strong>매치 재시작</strong><div className="muted small">현재 맵을 다시 불러옵니다. 로테이션 위치는 그대로이고 설정 파일은 다시 읽지 않습니다.</div></div>
        <button className="btn btn-danger-outline ctl-btn" type="button" disabled={!admin} onClick={restartMatch}>재시작</button>
      </div>
      <div className="row-between">
        <div><strong>매치 종료</strong><div className="muted small">로테이션의 다음 맵으로 넘어갑니다. 로테이션이 꺼져 있으면 현재 맵을 다시 불러옵니다.</div></div>
        <button className="btn btn-danger ctl-btn" type="button" disabled={!admin} onClick={endMatch}>종료</button>
      </div>
    </>
  );
}

function TickTimer({ admin }: { admin: boolean }) {
  const caps = useStore((s) => s.caps);
  const editable = admin && (caps?.features?.configDocument ?? true);
  const [saved, setSaved] = useState<OrError<ScorePeriod> | null>(null);
  const [value, setValue] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<ScorePeriod>('GET', '/api/score-period').then(
      (d) => {
        setSaved(d);
        setValue(d.saved ?? d.current ?? d.range[0]);
      },
      (err) => setSaved({ error: errorMessage(err) }),
    );
  }, []);

  if (!saved) return null;
  if (saved.error !== undefined) return <p className="muted small">점수 주기를 불러오지 못했습니다: {saved.error}</p>;
  const [min, max] = saved.range;
  const [lo, hi, mult] = bandOf(value);
  const scale = `${lo === hi ? `${lo}초` : `${lo}–${hi}초`} (×${mult})`;
  const dirty = value !== (saved.saved ?? saved.current);
  const staged = !dirty && saved.saved != null && saved.current != null && saved.saved !== saved.current;

  const apply = async () => {
    setBusy(true);
    if (await run('점수 주기', 'PUT', '/api/score-period', { value })) setSaved((s) => (s && s.error === undefined ? { ...s, saved: value } : s));
    setBusy(false);
  };

  return (
    <div className="field">
      <span className="field-label">
        <span>점수 주기 (틱 타이머)</span>
        <span>
          {dirty ? <span className="tag tag-hs">적용 전</span> : staged ? <span className="tag tag-hs" title={`지금 매치는 ${saved.current}초`}>다음 매치 예정</span> : null}
          <span className="tag">다음 매치</span>
        </span>
      </span>
      <div className="reward"><span>컨트롤 존</span><b>{`$${ZONE_BASE.control * mult}`}</b><span className="muted small">{scale}</span></div>
      <div className="slider-row">
        <span className="muted small">{`${min}초`}</span>
        <input type="range" min={min} max={max} step={1} value={value} disabled={!editable} aria-label="점수 주기"
          onChange={(e) => setValue(Number(e.target.value))} />
        <span className="muted small">{`${max}초`}</span>
        <output className="slider-value">{`${value}초`}</output>
      </div>
      <div className="reward"><span>핫 존</span><b>{`$${ZONE_BASE.hot * mult}`}</b><span className="muted small">{scale}</span></div>
      <div className="row-between">
        <span className="muted small">{`지금 매치 ${saved.current ?? '—'}초 · 주기가 짧을수록 자주, 적게 지급합니다.`}</span>
        <button className="btn ctl-btn" type="button" disabled={!editable || !dirty || busy} onClick={apply}>적용</button>
      </div>
    </div>
  );
}

function Rotation({ rev, admin, onChange }: { rev: number; admin: boolean; onChange: () => void }) {
  const currentMap = useStore((s) => s.live?.status?.map);
  const caps = useStore((s) => s.caps);
  const editable = admin && (caps?.features?.configDocument ?? true);
  const [r, setR] = useState<OrError<RotationData> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    api<RotationData>('GET', '/api/rotation').then(
      (d) => !stale && setR(d),
      (err) => !stale && setR({ error: errorMessage(err) }),
    );
    return () => {
      stale = true;
    };
  }, [currentMap, rev]);

  const edit = async (label: string, method: string, path: string, body?: unknown) => {
    setBusy(true);
    const ok = await run(label, method, path, body);
    setBusy(false);
    if (ok) onChange();
  };
  const remove = async (i: number, e: { map: string }) => {
    if (await confirmAction('로테이션 항목 삭제', `${i + 1}번 ${e.map} 항목을 지웁니다.`, { confirm: '삭제' })) {
      await edit('로테이션 삭제', 'DELETE', `/api/rotation/${i}`);
    }
  };

  const jump = async (i: number, e: { map: string }) => {
    if (await confirmAction('로테이션 이동', `${i + 1}번 ${e.map} 항목을 다음 맵으로 정하고 지금 매치를 끝냅니다. 종료 화면이 지나면 그 맵으로 이동합니다.`, { confirm: '이동' })) {
      await edit('로테이션 이동', 'POST', `/api/rotation/${i}/jump`);
    }
  };

  if (!r) return null;
  if (r.error !== undefined) return <Empty>로테이션을 불러오지 못했습니다: {r.error}</Empty>;
  const entries = r.entries || [];
  const random = r.mode === 'random';
  return (
    <>
      <div className="row-wrap">
        <div className="seg" role="radiogroup" aria-label="로테이션 사용">
          <button type="button" role="radio" aria-checked={!!r.enabled} className={r.enabled ? 'on' : ''} disabled={!editable || busy || r.enabled}
            onClick={() => edit('로테이션 켜기', 'PUT', '/api/rotation/settings', { enabled: true })}>사용</button>
          <button type="button" role="radio" aria-checked={!r.enabled} className={r.enabled ? '' : 'on'} disabled={!editable || busy || !r.enabled}
            onClick={() => edit('로테이션 끄기', 'PUT', '/api/rotation/settings', { enabled: false })}>끄기</button>
        </div>
        <div className="seg" role="radiogroup" aria-label="로테이션 순서">
          <button type="button" role="radio" aria-checked={!random} className={random ? '' : 'on'} disabled={!editable || busy || !random}
            onClick={() => edit('로테이션 순서', 'PUT', '/api/rotation/settings', { mode: 'ordered' })}>순서대로</button>
          <button type="button" role="radio" aria-checked={random} className={random ? 'on' : ''} disabled={!editable || busy || random}
            onClick={() => edit('로테이션 순서', 'PUT', '/api/rotation/settings', { mode: 'random' })}>무작위</button>
        </div>
      </div>
      <p className="muted small">{`편집은 설정 문서를 고쳐 적용하며, 다음 맵 전환부터 반영됩니다.${r.enabled ? '' : ' 꺼져 있으면 매치가 끝날 때 지금 맵을 다시 불러옵니다.'}`}</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th className="num">#</th><th>맵</th><th>모드</th><th>조명</th><th>상태</th>{editable ? <th aria-label="편집" /> : null}</tr></thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i} className={e.status === 'now' ? 'row-now' : ''}>
                <td className="num">{(e.index ?? i) + 1}</td>
                <td><span className="inline-row"><MapArt map={e.map} lighting={e.lighting} variant="wide" />{e.map}</span></td>
                <td>{(e.experiences || []).join(', ')}</td>
                <td>{e.lighting || '—'}</td>
                <td>
                  {e.status === 'now' ? <span className="tag tag-hs">진행 중</span> : e.status === 'next' ? <span className="tag">다음</span> : null}
                  {e.denied ? <span className="tag tag-danger" title="서버가 모르는 모드를 참조합니다">거부됨</span> : null}
                </td>
                {editable ? (
                  <td className="nowrap">
                    <IconButton icon={faForwardStep} label={!r.enabled ? '로테이션이 꺼져 있어 이동할 수 없습니다' : e.denied ? '거부된 항목' : '이 맵으로 이동'}
                      disabled={busy || !r.enabled || e.status === 'now' || !!e.denied} onClick={() => jump(i, e)} />
                    <IconButton icon={faArrowUp} label="위로" disabled={busy || i === 0}
                      onClick={() => edit('로테이션 이동', 'POST', `/api/rotation/${i}/move`, { to: i - 1 })} />
                    <IconButton icon={faArrowDown} label="아래로" disabled={busy || i === entries.length - 1}
                      onClick={() => edit('로테이션 이동', 'POST', `/api/rotation/${i}/move`, { to: i + 1 })} />
                    <IconButton icon={faTrash} label="삭제" className="btn-danger-outline" disabled={busy || entries.length <= 1}
                      onClick={() => remove(i, e)} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

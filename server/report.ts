import type { IncomingMessage } from 'node:http';
import { HttpError, requireText } from './http.ts';
import type { Router, SseHub } from './http.ts';
import type { Store } from './store.ts';
import type { Poller } from './poller.ts';
import type { Account, Provider } from './link.ts';

const REPORT_CATEGORIES: Record<string, string> = {
  cheat: '핵·치트',
  teamkill: '팀킬',
  abuse: '욕설·비매너',
  grief: '트롤·고의 방해',
  other: '기타',
};
const STATUSES = ['open', 'resolved', 'rejected'];
const PER_HOUR = 5;
const MAX_TARGET = 64;
const MAX_DESCRIPTION = 1000;
const MAX_URL = 300;
const MAX_NOTE = 500;

function evidenceUrl(value: unknown): string | null {
  const s = requireText(value, '증거 링크', MAX_URL, { optional: true });
  if (!s) return null;
  const u = URL.parse(s);
  if (u?.protocol !== 'https:' && u?.protocol !== 'http:') throw new HttpError(400, 'bad_url', '증거 링크는 http:// 또는 https:// 로 시작하는 주소여야 합니다');
  return u.href;
}

interface ReportContext {
  store: Store;
  poller: Poller;
  hub: SseHub;
  configured: Record<Provider, boolean>;
  accounts: (req: IncomingMessage) => { chzzk?: Account; steam?: Account } | null;
}

export function registerReports(router: Router, { store, poller, hub, configured, accounts }: ReportContext): void {
  const chzzkOf = (req: IncomingMessage) => {
    const a = accounts(req);
    return a?.chzzk ? { chzzk: a.chzzk, steam: a.steam } : null;
  };
  const reporterOf = (req: IncomingMessage) => {
    const a = chzzkOf(req);
    if (!a) throw new HttpError(401, 'unauthenticated', '치지직으로 먼저 로그인해주세요');
    return a;
  };

  const mine = (a: { chzzk: Account }) => store.reportsByReporter(a.chzzk.id, { limit: 10 })
    .map((r) => ({ id: r.id, createdAt: r.createdAt, targetName: r.targetName, status: r.status }));

  router.add('GET', '/api/report/me', { public: true }, ({ req }) => {
    const a = chzzkOf(req);
    return {
      configured: configured.chzzk,
      reporter: a ? a.chzzk.name : null,
      mine: a ? mine(a) : [],
      online: a ? poller.players.map((p) => p.name).filter((n): n is string => !!n) : [],
    };
  });

  router.add('POST', '/api/report', { public: true }, ({ req, body }) => {
    const a = reporterOf(req);
    const now = Date.now();
    if (store.reportsByReporter(a.chzzk.id, { since: now - 3600_000, limit: PER_HOUR }).length >= PER_HOUR) {
      throw new HttpError(429, 'too_many_reports', `신고는 1시간에 ${PER_HOUR}건까지 할 수 있습니다`);
    }
    const category = String(body.category ?? 'other');
    if (!Object.hasOwn(REPORT_CATEGORIES, category)) throw new HttpError(400, 'bad_category', '신고 유형이 올바르지 않습니다');
    const targetName = requireText(body.targetName, '닉네임', MAX_TARGET);
    const online = poller.players.find((p) => p.name === targetName && p.steamId);
    const report = store.addReport({
      createdAt: now,
      reporterChzzkId: a.chzzk.id,
      reporterChzzkName: a.chzzk.name,
      reporterSteamId: a.steam?.id ?? null,
      reporterSteamName: a.steam?.name ?? null,
      targetName,
      targetSteamId: online?.steamId ?? store.steamIdByName(targetName),
      category,
      description: requireText(body.description, '사유', MAX_DESCRIPTION),
      evidenceUrl: evidenceUrl(body.evidenceUrl),
      map: poller.status?.map ?? null,
    });
    hub.broadcast('report', report);
    return { ok: true, mine: mine(a) };
  });

  router.add('GET', '/api/reports', { role: 'viewer' }, ({ query }) => {
    const status = query.get('status');
    return { categories: REPORT_CATEGORIES, reports: store.reports({ status: status && STATUSES.includes(status) ? status : undefined }) };
  });

  router.add('POST', '/api/reports/:id', { role: 'mod' }, ({ params, body, session }) => {
    const id = Number(params.id);
    const status = String(body.status ?? '');
    if (!STATUSES.includes(status)) throw new HttpError(400, 'bad_status', '상태가 올바르지 않습니다');
    const note = requireText(body.note, '메모', MAX_NOTE, { optional: true }) || null;
    if (!store.report(id)) throw new HttpError(404, 'not_found', '없는 신고입니다');
    const report = store.updateReport(id, status, note, session.name, Date.now());
    hub.broadcast('action', store.logAction(session.name, 'report_update', String(id), { status, note, name: report?.targetName }, true));
    return report;
  });
}

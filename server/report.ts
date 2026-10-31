import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, requireText, readBody, readJson } from './http.ts';
import type { Router, Handler, Body } from './http.ts';
import type { Store, Report, NewReport } from './store.ts';
import { DISCORD_ID } from './discord.ts';
import type { Fleet, ServerRuntime } from './fleet.ts';
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

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_QUOTA_BYTES = 5 * 1024 ** 3;
const DAILY_IMAGE_BYTES = 50 * 1024 * 1024;
const UPLOAD_WINDOW_MS = 15 * 60_000;
const IMAGE_KEEP_MS = 30 * 86400_000;
const CSRF_HEADER = 'x-requested-with';

function sniffImage(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function sendImage(res: ServerResponse, dir: string, img: { file: string; mime: string }): Promise<void> {
  let data: Buffer;
  try {
    data = await readFile(join(dir, img.file));
  } catch {
    throw new HttpError(404, 'not_found', '이미지를 찾을 수 없습니다');
  }
  res.writeHead(200, {
    'Content-Type': img.mime,
    'Content-Length': data.length,
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Content-Disposition': 'inline',
  });
  res.end(data);
}

function evidenceUrl(value: unknown): string | null {
  const s = requireText(value, '증거 링크', MAX_URL, { optional: true });
  if (!s) return null;
  const u = URL.parse(s);
  if (u?.protocol !== 'https:' && u?.protocol !== 'http:') throw new HttpError(400, 'bad_url', '증거 링크는 http:// 또는 https:// 로 시작하는 주소여야 합니다');
  return u.href;
}

interface ReportContext {
  store: Store;
  fleet: Fleet;
  configured: Record<Provider, boolean>;
  accounts: (req: IncomingMessage) => Promise<{ chzzk?: Account; steam?: Account } | null>;
  bot: (handler: Handler) => Handler;
  imagesDir: string;
}

type Reporter = Pick<NewReport, 'reporterChzzkId' | 'reporterChzzkName' | 'reporterSteamId' | 'reporterSteamName' | 'reporterDiscordId' | 'reporterDiscordName'>;

export function registerReports(router: Router, { store, fleet, configured, accounts, bot, imagesDir }: ReportContext): void {
  mkdirSync(imagesDir, { recursive: true, mode: 0o700 });
  const withImages = <T extends { id: number }>(list: T[]) => {
    const ids = store.reportImageIds(list.map((r) => r.id));
    return list.map((r) => ({ ...r, images: ids.get(r.id) ?? [] }));
  };

  const publicServers = () => fleet.all().filter((s) => s.public);
  const serversFor = (code: unknown) => {
    if (!code) return publicServers();
    const srv = fleet.byJoinCode(String(code));
    if (!srv) throw new HttpError(404, 'no_server', '없는 서버 주소입니다');
    return [srv];
  };
  const serverOf = (v: unknown, code: unknown): ServerRuntime => {
    const list = serversFor(code);
    const srv = v == null || v === '' ? (list.length === 1 ? list[0] : undefined) : list.find((s) => s.id === Number(v));
    if (!srv) throw new HttpError(400, 'bad_server', '신고할 서버를 고르세요');
    return srv;
  };
  const steamOf = async (req: IncomingMessage) => {
    const a = await accounts(req);
    return a?.steam ? { steam: a.steam, chzzk: a.chzzk } : null;
  };
  const reporterOf = async (req: IncomingMessage) => {
    const a = await steamOf(req);
    if (!a) throw new HttpError(401, 'unauthenticated', '스팀으로 먼저 로그인해주세요');
    return a;
  };

  const mine = (a: { steam: Account }) => withImages(store.reportsByReporter(a.steam.id, { limit: 10 })
    .map((r) => ({ id: r.id, createdAt: r.createdAt, targetName: r.targetName, status: r.status, serverName: r.serverName })));

  router.add('GET', '/api/report/me', { public: true }, async ({ req, query }) => {
    const a = await steamOf(req);
    const servers = serversFor(query.get('server'));
    return {
      configured: configured.steam,
      reporter: a ? a.steam.name : null,
      mine: a ? mine(a) : [],
      servers: servers.map((s) => ({ id: s.id, name: s.name })),
      online: a ? Object.fromEntries(servers.map((s) => [s.id, s.poller.players.map((p) => p.name).filter((n): n is string => !!n)])) : {},
    };
  });

  const submit = (srv: ServerRuntime, reporter: Reporter, recent: number, body: Body): Report => {
    if (recent >= PER_HOUR) throw new HttpError(429, 'too_many_reports', `신고는 1시간에 ${PER_HOUR}건까지 할 수 있습니다`);
    const category = String(body.category ?? 'other');
    if (!Object.hasOwn(REPORT_CATEGORIES, category)) throw new HttpError(400, 'bad_category', '신고 유형이 올바르지 않습니다');
    const targetName = requireText(body.targetName, '닉네임', MAX_TARGET);
    const online = srv.poller.players.find((p) => p.name === targetName && p.steamId);
    const report = srv.store.addReport({
      createdAt: Date.now(),
      ...reporter,
      targetName,
      targetSteamId: online?.steamId ?? srv.store.steamIdByName(targetName),
      category,
      description: requireText(body.description, '사유', MAX_DESCRIPTION),
      evidenceUrl: evidenceUrl(body.evidenceUrl),
      map: srv.poller.status?.map ?? null,
    });
    srv.emit('report', report);
    return report;
  };

  router.add('POST', '/api/report', { public: true }, async ({ req, body }) => {
    const a = await reporterOf(req);
    const srv = serverOf(body.server, body.code);
    const recent = store.reportsByReporter(a.steam.id, { since: Date.now() - 3600_000, limit: PER_HOUR }).length;
    const report = submit(srv, {
      reporterChzzkId: a.chzzk?.id ?? null,
      reporterChzzkName: a.chzzk?.name ?? null,
      reporterSteamId: a.steam.id,
      reporterSteamName: a.steam.name,
      reporterDiscordId: null,
      reporterDiscordName: null,
    }, recent, body);
    return { ok: true, id: report.id, mine: mine(a) };
  });

  router.add('POST', '/api/report/:id/images', { public: true, rawBody: true }, async ({ req, params }) => {
    if (req.headers[CSRF_HEADER] !== 'wardogs-dashboard') throw new HttpError(403, 'csrf', '요청 헤더가 없습니다');
    const a = await reporterOf(req);
    const report = store.reportById(Number(params.id));
    if (!report || report.reporterSteamId !== a.steam.id || report.reporterDiscordId) throw new HttpError(404, 'not_found', '없는 신고입니다');
    return saveImage(req, report);
  });

  const saveImage = async (req: IncomingMessage, report: Report) => {
    if (Date.now() - report.createdAt > UPLOAD_WINDOW_MS) throw new HttpError(403, 'upload_closed', '신고 접수 후 15분이 지나 이미지를 더 올릴 수 없습니다');
    const srv = fleet.get(report.serverId);
    if (!srv) throw new HttpError(404, 'not_found', '없는 신고입니다');
    const steamId = report.reporterSteamId;
    if (!steamId || !srv.store.hasPlayed(steamId)) {
      throw new HttpError(403, 'not_player', '이 서버에서 플레이한 기록이 있는 스팀 계정만 이미지를 올릴 수 있습니다. 대신 증거 링크를 남겨주세요');
    }
    if (srv.store.reportImageCount(report.id) >= MAX_IMAGES) throw new HttpError(400, 'too_many_images', `이미지는 신고 1건에 ${MAX_IMAGES}장까지입니다`);
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new HttpError(413, 'image_too_large', '이미지는 1장에 5MB까지입니다');
    const buf = await readBody(req, MAX_IMAGE_BYTES).catch((err) => {
      throw err instanceof HttpError && err.status === 413 ? new HttpError(413, 'image_too_large', '이미지는 1장에 5MB까지입니다') : err;
    });
    const mime = sniffImage(buf);
    if (!mime) throw new HttpError(415, 'bad_image', 'JPG, PNG, WebP 이미지만 올릴 수 있습니다');
    if (store.reportImagesBytesBy(steamId, Date.now() - 86400_000) + buf.length > DAILY_IMAGE_BYTES) {
      throw new HttpError(429, 'image_daily_limit', '이미지는 하루에 50MB까지 올릴 수 있습니다. 대신 증거 링크를 남겨주세요');
    }
    if (store.reportImagesBytes() + buf.length > IMAGE_QUOTA_BYTES) {
      console.warn('[신고] 이미지 저장 공간(5GB)이 가득 차 업로드를 거부했습니다');
      throw new HttpError(507, 'image_storage_full', '이미지 저장 공간이 가득 차 지금은 이미지를 올릴 수 없습니다. 신고 내용은 접수되었습니다');
    }
    const file = randomUUID();
    await writeFile(join(imagesDir, file), buf, { mode: 0o600, flag: 'wx' });
    return { id: srv.store.addReportImage(report.id, file, mime, buf.length, Date.now()) };
  };

  const discordIdOf = (v: unknown) => {
    const id = String(v ?? '');
    if (!DISCORD_ID.test(id)) throw new HttpError(400, 'bad_discord_id', 'invalid discordId');
    return id;
  };
  const discordRecent = (discordId: string) => store.reportCountByDiscord(discordId, Date.now() - 3600_000);

  router.add('GET', '/api/discord/report', { public: true }, bot(({ query }) => {
    const discordId = discordIdOf(query.get('discordId'));
    const srv = fleet.get(Number(query.get('serverId')));
    if (!srv) throw new HttpError(404, 'unknown_server', 'unknown server');
    return {
      server: { id: srv.id, name: srv.name },
      remaining: Math.max(0, PER_HOUR - discordRecent(discordId)),
      limits: { perHour: PER_HOUR, target: MAX_TARGET, description: MAX_DESCRIPTION, images: MAX_IMAGES, imageBytes: MAX_IMAGE_BYTES },
    };
  }));

  router.add('POST', '/api/discord/reports', { public: true, rawBody: true }, bot(async ({ req }) => {
    const body = await readJson(req, 16 * 1024);
    const discordId = discordIdOf(body.discordId);
    const discordName = requireText(body.discordName, 'discordName', 100);
    const srv = fleet.get(Number(body.serverId));
    if (!srv) throw new HttpError(404, 'unknown_server', 'unknown server');
    const link = srv.store.discordLink('discord', discordId);
    const report = submit(srv, {
      reporterChzzkId: link?.chzzkChannelId ?? null,
      reporterChzzkName: link?.chzzkName ?? null,
      reporterSteamId: link?.steamId ?? null,
      reporterSteamName: link?.steamName ?? null,
      reporterDiscordId: discordId,
      reporterDiscordName: discordName,
    }, discordRecent(discordId), body);
    return { ok: true, id: report.id, targetSteamId: report.targetSteamId };
  }));

  router.add('POST', '/api/discord/reports/:id/images', { public: true, rawBody: true }, bot(async ({ req, params, query }) => {
    const discordId = discordIdOf(query.get('discordId'));
    const report = store.reportById(Number(params.id));
    if (!report || report.reporterDiscordId !== discordId) throw new HttpError(404, 'not_found', '없는 신고입니다');
    return saveImage(req, report);
  }));

  router.add('GET', '/api/report/images/:img', { public: true, stream: true }, async ({ req, res, params }) => {
    const a = await steamOf(req);
    const img = store.reportImage(Number(params.img));
    if (!a || !img || img.reporterSteamId !== a.steam.id || img.reporterDiscordId) throw new HttpError(404, 'not_found', '이미지를 찾을 수 없습니다');
    await sendImage(res, imagesDir, img);
  });

  router.add('GET', '/api/s/:sid/reports/:id/images/:img', { role: 'viewer', stream: true }, async ({ res, params, srv }) => {
    const img = srv.store.reportImageOf(Number(params.id), Number(params.img));
    if (!img) throw new HttpError(404, 'not_found', '이미지를 찾을 수 없습니다');
    await sendImage(res, imagesDir, img);
  });

  const cleanup = async () => {
    for (const img of store.expiredReportImages(Date.now() - IMAGE_KEEP_MS)) {
      await unlink(join(imagesDir, img.file)).catch(() => {});
      store.deleteReportImage(img.id);
    }
    const known = store.reportImageFiles();
    for (const f of await readdir(imagesDir).catch(() => [] as string[])) {
      if (known.has(f)) continue;
      const st = await stat(join(imagesDir, f)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 3600_000) await unlink(join(imagesDir, f)).catch(() => {});
    }
  };
  cleanup().catch((err) => console.error('[신고] 이미지 정리 실패:', err));
  setInterval(() => cleanup().catch((err) => console.error('[신고] 이미지 정리 실패:', err)), 3600_000).unref();

  router.add('GET', '/api/s/:sid/reports', { role: 'viewer' }, ({ query, srv }) => {
    const status = query.get('status');
    return { categories: REPORT_CATEGORIES, reports: withImages(srv.store.reports({ status: status && STATUSES.includes(status) ? status : undefined })) };
  });

  router.add('POST', '/api/s/:sid/reports/:id', { role: 'mod' }, ({ params, body, session, srv }) => {
    const id = Number(params.id);
    const status = String(body.status ?? '');
    if (!STATUSES.includes(status)) throw new HttpError(400, 'bad_status', '상태가 올바르지 않습니다');
    const note = requireText(body.note, '메모', MAX_NOTE, { optional: true }) || null;
    if (!srv.store.report(id)) throw new HttpError(404, 'not_found', '없는 신고입니다');
    const report = srv.store.updateReport(id, status, note, session.name, Date.now());
    srv.emit('action', srv.store.logAction(session.name, 'report_update', String(id), { status, note, name: report?.targetName }, true));
    return report;
  });
}

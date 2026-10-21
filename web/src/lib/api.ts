import { setState } from './store.ts';
import { toast } from './toast.ts';
import { request } from './publicApi.ts';

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  result: unknown;

  constructor(message: string, status: number, code?: string, result?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.result = result;
  }
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const { res, data } = await request(method, path, body);
  if (res.status === 401) {
    setState({ me: null });
    throw new Error('로그인이 필요합니다');
  }
  if (!res.ok) {
    throw new ApiError(data.error?.message || `요청 실패 (${res.status})`, res.status, data.error?.code, data.result);
  }
  return data;
}

export async function run(label: string, method: string, path: string, body?: unknown): Promise<{ message?: string } | null> {
  try {
    const r = await api<{ message?: string }>(method, path, body);
    toast(r.message ? `${label}: ${r.message}` : `${label} 완료`);
    return r;
  } catch (err) {
    toast(`${label} 실패: ${errorMessage(err)}`, 'error');
    return null;
  }
}

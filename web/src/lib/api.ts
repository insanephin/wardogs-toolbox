import { setState } from './store.ts';
import { toast } from './toast.ts';

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  // A rejected config document comes back with the validation result.
  result: unknown;

  constructor(message: string, status: number, code?: string, result?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.result = result;
  }
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// T is what the caller expects the endpoint to return; the response is not checked against it.
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'X-Requested-With': 'wardogs-dashboard', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    // Dropping `me` swaps the shell for the login screen, which also closes the stream.
    setState({ me: null });
    throw new Error('로그인이 필요합니다');
  }
  if (!res.ok) {
    throw new ApiError(data.error?.message || `요청 실패 (${res.status})`, res.status, data.error?.code, data.result);
  }
  return data;
}

// Runs a write and reports the outcome; returns the result or null on failure.
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

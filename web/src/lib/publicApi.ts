export async function request(method: string, path: string, body?: unknown): Promise<{ res: Response; data: any }> {
  const res = await fetch(path, {
    method,
    headers: { 'X-Requested-With': 'wardogs-dashboard', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  return { res, data: await res.json().catch(() => ({})) };
}

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { res, data } = await request(method, path, body);
  if (!res.ok) throw new Error(data.error?.message || `요청 실패 (${res.status})`);
  return data;
}

import { useSyncExternalStore } from 'react';

type ToastKind = 'ok' | 'warn' | 'error';

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
  out: boolean;
}

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = (next: Toast[]) => {
  toasts = next;
  for (const l of listeners) l();
};

export function toast(message: string, kind: ToastKind = 'ok'): void {
  const id = ++seq;
  const life = kind === 'error' ? 7000 : 4000;
  emit([...toasts, { id, message, kind, out: false }]);
  setTimeout(() => emit(toasts.map((t) => (t.id === id ? { ...t, out: true } : t))), life - 500);
  setTimeout(() => emit(toasts.filter((t) => t.id !== id)), life);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore((fn) => (listeners.add(fn), () => listeners.delete(fn)), () => toasts);
}

export async function copyText(text: string, done = '복사했습니다'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch (err) {
    toast(`복사하지 못했습니다: ${err instanceof Error ? err.message : err}`, 'error');
  }
}

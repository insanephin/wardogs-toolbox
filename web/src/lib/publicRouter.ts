import { useSyncExternalStore } from 'react';
import type { MouseEvent } from 'react';

const subs = new Set<() => void>();
const notify = () => {
  for (const f of subs) f();
};
addEventListener('popstate', notify);

const currentPath = () => location.pathname.replace(/\/+$/, '') || '/';

export const usePath = () => useSyncExternalStore((f) => {
  subs.add(f);
  return () => subs.delete(f);
}, currentPath);

export function followLink(e: MouseEvent<HTMLAnchorElement>) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const to = e.currentTarget.pathname;
  if (to === currentPath()) return;
  history.pushState(null, '', to);
  notify();
}

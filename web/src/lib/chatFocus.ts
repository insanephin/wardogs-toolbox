export interface ChatFocus {
  steamId: string;
  name: string;
}

let pending: ChatFocus | null = null;

export function focusChatPlayer(p: ChatFocus): void {
  pending = p;
  if (location.hash === '#chat') window.dispatchEvent(new Event('chatfocus'));
  else location.hash = '#chat';
}

export function takeChatFocus(): ChatFocus | null {
  const p = pending;
  pending = null;
  return p;
}

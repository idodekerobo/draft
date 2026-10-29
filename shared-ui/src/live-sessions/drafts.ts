import { useCallback, useSyncExternalStore } from "react";

export const NEW_SESSION_DRAFT_KEY = "new-session";

// Module-level so drafts outlive the composer, which unmounts on every session switch.
const drafts = new Map<string, string>();
const listeners = new Set<() => void>();

function write(key: string, text: string) {
  if (text) drafts.set(key, text);
  else drafts.delete(key);
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const hasDraft = (key: string) => drafts.has(key);

export function clearDraft(key: string) {
  write(key, "");
}

/** Puts texts in front of what the person already typed, so a message pulled back is not lost. */
export function prependToDraft(key: string, texts: string[]) {
  const restored = texts.filter(Boolean).join("\n\n");
  if (!restored) return;
  const current = drafts.get(key);
  write(key, current ? `${restored}\n\n${current}` : restored);
}

/** Like useState for a textarea, but the text is remembered per key until `clearDraft`. */
export function useDraft(key: string): [string, (text: string) => void] {
  const text = useSyncExternalStore(subscribe, () => drafts.get(key) ?? "", () => "");
  const setText = useCallback((next: string) => write(key, next), [key]);
  return [text, setText];
}

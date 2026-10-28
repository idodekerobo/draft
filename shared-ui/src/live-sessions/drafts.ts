import { useCallback, useState } from "react";

export const NEW_SESSION_DRAFT_KEY = "new-session";

// Module-level so drafts outlive the composer, which unmounts on every session switch.
const drafts = new Map<string, string>();

export function clearDraft(key: string) {
  drafts.delete(key);
}

/** Like useState for a textarea, but the text is remembered per key until `clearDraft`. */
export function useDraft(key: string): [string, (text: string) => void] {
  const [text, setLocal] = useState(() => drafts.get(key) ?? "");
  const setText = useCallback(
    (next: string) => {
      if (next) drafts.set(key, next);
      else drafts.delete(key);
      setLocal(next);
    },
    [key],
  );
  return [text, setText];
}

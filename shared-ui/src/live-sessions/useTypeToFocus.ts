"use client";

import { useEffect, type RefObject } from "react";

const TEXT_TARGET = "input, textarea, select, [contenteditable=''], [contenteditable='true']";
const OVERLAY_TARGET = "[role='menu'], [role='listbox'], [role='dialog']";

/** Sends the first printable keystroke to the field, so typing anywhere in the view starts a message. */
export function useTypeToFocus(ref: RefObject<HTMLTextAreaElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1 || event.key === " ") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(TEXT_TARGET) || target?.closest(OVERLAY_TARGET)) return;
      // Focusing during keydown makes the browser type this character into the field.
      ref.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ref, enabled]);
}

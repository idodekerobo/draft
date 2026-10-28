import { useLayoutEffect, type KeyboardEvent, type RefObject } from "react";

/** Enter sends; Shift+Enter and Option+Enter add a line, and Enter while an input method composes text is left alone. */
export function submitOnEnter(submit: () => void) {
  return (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (event.altKey) {
      // Browsers add no newline for Alt+Enter, so insert one and let React see an input event.
      const el = event.currentTarget;
      el.setRangeText("\n", el.selectionStart, el.selectionEnd, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      submit();
    }
  };
}

/** Grows the textarea to fit its text; the CSS max-height caps it and scrolls past that. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    // Browsers do not scroll the caret into view after a programmatic resize.
    if (el.selectionEnd === el.value.length) el.scrollTop = el.scrollHeight;
  }, [ref, value]);
}

export function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z" />
    </svg>
  );
}

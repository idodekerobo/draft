"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Modal built on the native dialog: focus is contained and Escape closes it. */
export function Dialog({ titleId, onClose, busy, children }: {
  titleId: string;
  onClose: () => void;
  /** Blocks dismissal while a save is in flight. */
  busy?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    // Focus the dialog itself so no control shows a ring before the member tabs in.
    dialog.focus({ preventScroll: true });
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="ui-dialog"
      tabIndex={-1}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current && !busy) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

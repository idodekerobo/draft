"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/** Modal built on the native dialog: focus is contained and Escape closes it. */
export function Dialog({ titleId, onClose, busy, wide, narrow, returnFocusTo, children }: {
  titleId: string;
  /** Room for a form and its preview side by side. */
  wide?: boolean;
  /** A short question with two buttons. */
  narrow?: boolean;
  onClose: () => void;
  /** Blocks dismissal while a save is in flight. */
  busy?: boolean;
  /** The control that opened the dialog, recorded at the click. Focus returns there on close. */
  returnFocusTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // WebKit does not focus a button on click, so the focused element can be the page body.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const returnTo = returnFocusTo?.current ?? opener;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    // Focus the dialog itself so no control shows a ring before the member tabs in.
    dialog.focus({ preventScroll: true });
    return () => {
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={wide ? "ui-dialog ui-dialog--wide" : narrow ? "ui-dialog ui-dialog--narrow" : "ui-dialog"}
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

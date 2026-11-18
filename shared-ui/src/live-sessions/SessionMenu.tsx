"use client";

import { useCallback, useState, type ReactNode } from "react";
import { Dialog } from "../routines/Dialog";
import { usePopover } from "./usePopover";
import type { LiveSession, LiveSessionsApi } from "./types";

export interface SessionMenuItem {
  label: string;
  onSelect: () => unknown;
  /** Ask before running, in a dialog: this is the question, and the label is the confirm button. */
  confirm?: string;
  /** Styled as destructive. */
  danger?: boolean;
}

export function SessionMenu({ items, onSelect, variant = "header" }: { items: SessionMenuItem[]; onSelect: (item: SessionMenuItem) => void; variant?: "header" | "row" }) {
  const { open, setOpen, rootRef, triggerRef } = usePopover();
  if (items.length === 0) return null;
  return (
    <div className={`ui-session__menu${variant === "row" ? " ui-session__menu--row" : ""}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={variant === "row" ? "ui-sessions__row-menu" : "ui-btn ui-session__menu-trigger"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Session options"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">…</span>
      </button>
      {open && (
        <ul className="ui-session__menu-list" role="menu">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                className={`ui-session__menu-item${item.danger ? " ui-session__menu-item--danger" : ""}`}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                  onSelect(item);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const DELETE_LIVE = "Delete this session? It ends first, and then nobody on your team can see it. Files on your computer are not removed.";
const DELETE_IDLE = "Delete this session? Nobody on your team will be able to see it. Files on your computer are not removed.";

interface UseSessionMenuOptions {
  api: Pick<LiveSessionsApi, "deleteSession">;
  /** The app's own items, such as opening the folder. Delete is added last. */
  items?: (session: LiveSession) => SessionMenuItem[];
  onDeleted?: (sessionId: string) => void;
}

/** The menu items for a session, and the dialog that confirms the destructive ones. Render `dialog` once. */
export function useSessionMenu({ api, items, onDeleted }: UseSessionMenuOptions): {
  itemsFor: (session: LiveSession) => SessionMenuItem[];
  choose: (item: SessionMenuItem) => void;
  dialog: ReactNode;
} {
  const [confirming, setConfirming] = useState<SessionMenuItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const itemsFor = useCallback(
    (session: LiveSession): SessionMenuItem[] => {
      const own = items?.(session) ?? [];
      if (!api.deleteSession || !session.mine || session.session_type === "routine") return own;
      const running = session.status === "live" || session.status === "starting";
      return [
        ...own,
        {
          label: "Delete",
          danger: true,
          confirm: running ? DELETE_LIVE : DELETE_IDLE,
          onSelect: async () => {
            await api.deleteSession!(session.id);
            onDeleted?.(session.id);
          },
        },
      ];
    },
    [api, items, onDeleted],
  );

  const choose = useCallback((item: SessionMenuItem) => {
    if (!item.confirm) {
      void item.onSelect();
      return;
    }
    setError(null);
    setConfirming(item);
  }, []);

  const run = async () => {
    if (!confirming) return;
    setBusy(true);
    setError(null);
    try {
      await confirming.onSelect();
      setConfirming(null);
    } catch {
      setError("That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const dialog = confirming && (
    <Dialog titleId="session-confirm-title" busy={busy} onClose={() => setConfirming(null)}>
      <div className="ui-session__dialog">
        <h2 id="session-confirm-title" className="ui-session__dialog-title">{confirming.label} session?</h2>
        <p className="ui-session__dialog-text">{confirming.confirm}</p>
        {error && <p className="ui-error" role="alert">{error}</p>}
        <div className="ui-session__dialog-actions">
          <button type="button" className="ui-btn" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
          <button type="button" className={`ui-btn ${confirming.danger ? "ui-btn--danger" : "ui-btn--primary"}`} disabled={busy} onClick={() => void run()}>
            {busy ? "Working…" : confirming.label}
          </button>
        </div>
      </div>
    </Dialog>
  );

  return { itemsFor, choose, dialog };
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApprovalPanel } from "./ApprovalPanel";
import { ColumnToggleButton } from "./SessionsLayout";
import { SessionComposer } from "./SessionComposer";
import { SessionStream } from "./SessionStream";
import { sessionTitle } from "./sessions-list";
import { buildStreamItems, openApprovals } from "./stream-items";
import { usePopover } from "./usePopover";
import { useSessionInputs } from "./useSessionInputs";
import { useSessionStream } from "./useSessionStream";
import type { LiveSession, LiveSessionsApi } from "./types";

export interface SessionMenuItem {
  label: string;
  onSelect: () => void;
  /** Ask before running: a question, with the label as the confirm button. */
  confirm?: string;
}

const NEAR_BOTTOM_PX = 96;
const STOPPING_MS = 3_000;

function SessionMenu({ items, onSelect }: { items: SessionMenuItem[]; onSelect: (item: SessionMenuItem) => void }) {
  const { open, setOpen, rootRef, triggerRef } = usePopover();
  if (items.length === 0) return null;
  return (
    <div className="ui-session__menu" ref={rootRef}>
      <button ref={triggerRef} type="button" className="ui-btn ui-session__menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label="Session options" onClick={() => setOpen((v) => !v)}>
        <span aria-hidden="true">…</span>
      </button>
      {open && (
        <ul className="ui-session__menu-list" role="menu">
          {items.map((item) => (
            <li key={item.label} role="none">
              <button
                type="button"
                role="menuitem"
                className="ui-session__menu-item"
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

/** One session: breadcrumb header, a stream that follows new messages, and a message box pinned below. */
export function SessionView({
  api,
  sessionId,
  back,
  menuItems,
  notice,
}: {
  api: LiveSessionsApi;
  sessionId: string;
  /** The "Sessions" crumb, for apps where the list is not always beside the session. */
  back?: ReactNode;
  menuItems?: (session: LiveSession) => SessionMenuItem[];
  notice?: string | null;
}) {
  const { session, events, error } = useSessionStream(api, sessionId);
  const inputs = useSessionInputs(api, sessionId);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [confirming, setConfirming] = useState<SessionMenuItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const approvals = useMemo(() => openApprovals(buildStreamItems(events)), [events]);

  const jumpToLatest = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, []);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    following.current = near;
    setAtBottom(near);
  }, []);

  useEffect(() => {
    if (following.current) jumpToLatest();
  }, [events.length, inputs.inputs.length, jumpToLatest]);

  const stop = useCallback(async () => {
    setStopping(true);
    setActionError(null);
    try {
      await api.stop(sessionId);
    } catch {
      setActionError("Could not send Stop. Try again.");
    }
    setTimeout(() => setStopping(false), STOPPING_MS);
  }, [api, sessionId]);

  const chooseMenuItem = useCallback((item: SessionMenuItem) => {
    if (item.confirm) setConfirming(item);
    else item.onSelect();
  }, []);

  const ownerName = session?.owner_name ?? "the owner";
  const running = session !== null && (session.status === "live" || session.status === "starting");
  return (
    <div className="ui-session">
      <header className="ui-session__header">
        <nav className="ui-session__crumbs" aria-label="Breadcrumb">
          <ColumnToggleButton where="main" />
          {back && (
            <>
              {back}
              <span aria-hidden="true" className="ui-muted">/</span>
            </>
          )}
          <h1 className="ui-session__title">{session ? sessionTitle(session) : "Session"}</h1>
          {session && <span className="ui-muted ui-session__meta">{session.owner_name ?? "Someone"} · {session.status.replace("_", " ")}</span>}
        </nav>
        <div className="ui-session__actions">
          {running && (
            <button type="button" className="ui-btn" disabled={stopping} onClick={() => void stop()}>
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
          {session && menuItems && <SessionMenu items={menuItems(session)} onSelect={chooseMenuItem} />}
        </div>
      </header>
      {confirming && (
        <div className="ui-session__confirm" role="group" aria-label="Confirm">
          <p className="ui-session__confirm-text">{confirming.confirm}</p>
          <div className="ui-session__confirm-actions">
            <button type="button" className="ui-btn ui-btn--primary" onClick={() => { const item = confirming; setConfirming(null); item.onSelect(); }}>
              {confirming.label}
            </button>
            <button type="button" className="ui-btn" onClick={() => setConfirming(null)}>Cancel</button>
          </div>
        </div>
      )}
      {actionError && <p className="ui-error ui-session__notice" role="alert">{actionError}</p>}
      {notice && <p className="ui-error ui-session__notice" role="alert">{notice}</p>}
      <div className="ui-session__scroll" ref={scroller} onScroll={onScroll}>
        <div className="ui-session__column">
          {error && !session ? <p className="ui-error" role="alert">Could not load this session.</p> : <SessionStream events={events} ownerName={session?.owner_name ?? undefined} hostName={session?.host_name ?? null} />}
        </div>
      </div>
      {!atBottom && (
        <button type="button" className="ui-btn ui-session__jump" onClick={jumpToLatest} aria-label="Jump to latest message">↓</button>
      )}
      {session && (
        <div className="ui-session__footer">
          <div className="ui-session__column">
            {session.status !== "ended" &&
              approvals.map((approval) => (
                <ApprovalPanel key={approval.requestId} approval={approval} hostName={session.host_name} onDecide={(requestId, decision) => api.decideApproval(sessionId, requestId, decision)} />
              ))}
            <SessionComposer {...inputs} ownerName={ownerName} ended={session.status === "ended"} folderName={session.folder_name} />
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SessionComposer } from "./SessionComposer";
import { SessionStream } from "./SessionStream";
import { sessionTitle } from "./sessions-list";
import { useSessionInputs } from "./useSessionInputs";
import { useSessionStream } from "./useSessionStream";
import type { LiveSession, LiveSessionsApi } from "./types";

export interface SessionMenuItem {
  label: string;
  onSelect: () => void;
}

const NEAR_BOTTOM_PX = 96;

function SessionMenu({ items }: { items: SessionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (items.length === 0) return null;
  return (
    <div className="ui-session__menu" ref={root}>
      <button ref={trigger} type="button" className="ui-btn ui-session__menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label="Session options" onClick={() => setOpen((v) => !v)}>
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
                  trigger.current?.focus();
                  item.onSelect();
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
  /** The "Sessions" crumb; the app decides how it navigates. */
  back: ReactNode;
  menuItems?: (session: LiveSession) => SessionMenuItem[];
  notice?: string | null;
}) {
  const { session, events, error } = useSessionStream(api, sessionId);
  const inputs = useSessionInputs(api, sessionId);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

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

  const ownerName = session?.owner_name ?? "the owner";
  return (
    <div className="ui-session">
      <header className="ui-session__header">
        <nav className="ui-session__crumbs" aria-label="Breadcrumb">
          {back}
          <span aria-hidden="true" className="ui-muted">/</span>
          <h1 className="ui-session__title">{session ? sessionTitle(session) : "Session"}</h1>
          {session && <span className="ui-muted ui-session__meta">{session.owner_name ?? "Someone"} · {session.status.replace("_", " ")}</span>}
        </nav>
        {session && menuItems && <SessionMenu items={menuItems(session)} />}
      </header>
      {notice && <p className="ui-error ui-session__notice" role="alert">{notice}</p>}
      <div className="ui-session__scroll" ref={scroller} onScroll={onScroll}>
        <div className="ui-session__column">
          {error && !session ? <p className="ui-error" role="alert">Could not load this session.</p> : <SessionStream events={events} ownerName={session?.owner_name ?? undefined} />}
        </div>
      </div>
      {!atBottom && (
        <button type="button" className="ui-btn ui-session__jump" onClick={jumpToLatest} aria-label="Jump to latest message">↓</button>
      )}
      {session && (
        <div className="ui-session__footer">
          <div className="ui-session__column">
            <SessionComposer {...inputs} ownerName={ownerName} ended={session.status === "ended"} folderName={session.folder_name} />
          </div>
        </div>
      )}
    </div>
  );
}

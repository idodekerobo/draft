"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { COLUMN_DEFAULT_PX, clampColumnWidth, readColumnState, writeColumnState } from "./column-state";
import { groupSessionsByDay, relativeTime, sessionStatusLabel } from "./session-groups";
import { sessionTitle } from "./sessions-list";
import type { LiveSession } from "./types";

interface ColumnContext {
  open: boolean;
  toggle: () => void;
  columnButton: RefObject<HTMLButtonElement | null>;
  mainButton: RefObject<HTMLButtonElement | null>;
}

const SessionsColumnContext = createContext<ColumnContext | null>(null);

/** The show/hide button. One twin sits in the list header and one in the session header; only the visible one renders. */
export function ColumnToggleButton({ where }: { where: "column" | "main" }) {
  const column = useContext(SessionsColumnContext);
  if (!column || (where === "column") !== column.open) return null;
  return (
    <button
      ref={where === "column" ? column.columnButton : column.mainButton}
      type="button"
      className="ui-btn ui-sessions__toggle"
      aria-label={column.open ? "Hide sessions list" : "Show sessions list"}
      aria-expanded={column.open}
      aria-controls="sessions-column"
      onClick={column.toggle}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="2" />
        <path d="M6.5 3v10" />
      </svg>
    </button>
  );
}

function SessionRow({ session, selected, now, onSelect }: { session: LiveSession; selected: boolean; now: number; onSelect: (id: string) => void }) {
  return (
    <li>
      <button type="button" className="ui-sessions__row" aria-current={selected ? "true" : undefined} onClick={() => onSelect(session.id)}>
        <span className="ui-sessions__row-top">
          <span className="ui-sessions__row-title">{sessionTitle(session)}</span>
          <span className="ui-muted ui-sessions__row-time">{relativeTime(session.started_at, now)}</span>
        </span>
        <span className="ui-muted ui-sessions__row-sub">
          <span>{session.owner_name ?? "Someone"}</span>
          <span aria-hidden="true">·</span>
          <span className={`ui-sessions__dot ui-sessions__dot--${session.status}`} aria-hidden="true" />
          <span>{sessionStatusLabel(session.status)}</span>
        </span>
      </button>
    </li>
  );
}

const MINUTE_MS = 60_000;

/** Sessions list column beside the session area. Web and desktop both use it. */
export function SessionsLayout({
  sessions,
  loading = false,
  failed = false,
  selectedId,
  onSelect,
  onNew,
  resizable = false,
  children,
}: {
  sessions: LiveSession[];
  loading?: boolean;
  failed?: boolean;
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** Present when this app can start sessions. */
  onNew?: () => void;
  resizable?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(COLUMN_DEFAULT_PX);
  const [containerWidth, setContainerWidth] = useState(Infinity);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLDivElement>(null);
  const columnButton = useRef<HTMLButtonElement>(null);
  const mainButton = useRef<HTMLButtonElement>(null);
  const focusAfterToggle = useRef(false);
  const loaded = useRef(false);

  useEffect(() => {
    const stored = readColumnState(typeof window === "undefined" ? null : window.localStorage);
    setOpen(stored.open);
    setWidth(stored.width);
    loaded.current = true;
  }, []);

  useEffect(() => {
    if (loaded.current) writeColumnState(window.localStorage, { open, width });
  }, [open, width]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setContainerWidth(el.getBoundingClientRect().width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const toggle = useCallback(() => {
    focusAfterToggle.current = true;
    setOpen((value) => !value);
  }, []);

  useEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    (open ? columnButton : mainButton).current?.focus();
  }, [open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const effectiveWidth = clampColumnWidth(width, containerWidth);

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !root.current) return;
    const left = root.current.getBoundingClientRect().left;
    setWidth(clampColumnWidth(event.clientX - left, root.current.getBoundingClientRect().width));
  };

  const context = useMemo(() => ({ open, toggle, columnButton, mainButton }), [open, toggle]);
  const groups = useMemo(() => groupSessionsByDay(sessions, new Date(now)), [sessions, now]);

  return (
    <SessionsColumnContext.Provider value={context}>
      <div
        ref={root}
        className={`ui-sessions${selectedId ? " ui-sessions--selected" : ""}${dragging ? " ui-sessions--dragging" : ""}`}
        style={{ "--sessions-col-w": `${effectiveWidth}px` } as React.CSSProperties}
      >
        <aside id="sessions-column" className="ui-sessions__column" data-open={open} aria-label="Sessions" {...(open ? {} : { inert: true })}>
          <div className="ui-sessions__column-inner">
            <div className="ui-sessions__header">
              <h2 className="ui-sessions__heading">Sessions</h2>
              <ColumnToggleButton where="column" />
            </div>
            {onNew && (
              <button type="button" className="ui-btn ui-sessions__new" aria-current={selectedId === null ? "true" : undefined} onClick={onNew}>
                New session
              </button>
            )}
            <div className="ui-sessions__scroll">
              {failed && sessions.length === 0 ? (
                <p className="ui-error ui-sessions__note" role="alert">Could not load sessions. They will load again soon.</p>
              ) : loading && sessions.length === 0 ? (
                <p className="ui-muted ui-sessions__note" role="status">Loading sessions…</p>
              ) : groups.length === 0 ? (
                <p className="ui-muted ui-sessions__note" role="status">No sessions yet.</p>
              ) : (
                groups.map((group) => (
                  <section key={group.label} aria-label={group.label}>
                    <h3 className="ui-sessions__group">{group.label}</h3>
                    <ul className="ui-sessions__list">
                      {group.sessions.map((session) => (
                        <SessionRow key={session.id} session={session} selected={session.id === selectedId} now={now} onSelect={onSelect} />
                      ))}
                    </ul>
                  </section>
                ))
              )}
            </div>
          </div>
        </aside>
        {resizable && open && (
          <div
            className="ui-sessions__handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sessions list"
            onPointerDown={startDrag}
            onPointerMove={drag}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            onDoubleClick={() => setWidth(COLUMN_DEFAULT_PX)}
          />
        )}
        <div className="ui-sessions__main">{children}</div>
      </div>
    </SessionsColumnContext.Provider>
  );
}

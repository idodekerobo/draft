"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApprovalPanel } from "./ApprovalPanel";
import type { SessionEntry, TrackFn } from "../analytics/events";
import { DataBoundary } from "../query";
import { ColumnToggleButton } from "./SessionsLayout";
import { SessionComposer } from "./SessionComposer";
import { SessionStream } from "./SessionStream";
import { displayStatus } from "./display-status";
import { sessionBanner } from "./session-banner";
import { useMinuteClock } from "./useMinuteClock";
import { sessionTitle } from "./sessions-list";
import { pendingItems } from "./pending-items";
import { buildStreamItems, openApprovals } from "./stream-items";
import { usePopover } from "./usePopover";
import { presenceLine } from "./presence-line";
import { useSessionInputs } from "./useSessionInputs";
import { useSessionPresence } from "./useSessionPresence";
import { useSessionStream } from "./useSessionStream";
import { messageDomId, messageUrl, sessionUrl } from "./share-links";
import { SessionNotFoundError, type LiveSession, type LiveSessionLink, type LiveSessionsApi } from "./types";

export interface SessionMenuItem {
  label: string;
  onSelect: () => void;
  /** Ask before running: a question, with the label as the confirm button. */
  confirm?: string;
}

const NEAR_BOTTOM_PX = 96;

/** Scroll offset per session, kept while the app runs; null means the user was following the latest message. */
const scrollMemory = new Map<string, number | null>();
const STOPPING_MS = 3_000;
const HIGHLIGHT_MS = 2_000;
const COPIED_MS = 1_500;

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

interface SessionViewProps {
  api: LiveSessionsApi;
  sessionId: string;
  /** The "Sessions" crumb, for apps where the list is not always beside the session. */
  back?: ReactNode;
  menuItems?: (session: LiveSession) => SessionMenuItem[];
  notice?: string | null;
  /** Opens a linked session, from the line under the header of a cleared session. */
  onOpenSession?: (sessionId: string) => void;
  /** Put the cursor in the message box when the session opens, for a session the person just started. */
  autoFocusComposer?: boolean;
  /** Records that the session was opened. Without it, nothing is recorded. */
  track?: TrackFn;
  /** How the person got here. Defaults to inside the app. */
  entry?: SessionEntry;
  /** The web app origin that shared links point to. Without it, links cannot be copied. */
  shareBaseUrl?: string;
  /** The message a link points at. The view scrolls to it and highlights it. */
  focusSeq?: number | null;
  /** Shown on the no-access page, such as who is signed in and how to switch. */
  noAccessNote?: ReactNode;
}

function SessionNoAccess({ back, note }: { back?: ReactNode; note?: ReactNode }) {
  return (
    <div className="ui-session">
      <header className="ui-session__header">
        <Crumbs back={back}>
          <h1 className="ui-session__title">No access</h1>
        </Crumbs>
      </header>
      <div className="ui-session__scroll">
        <div className="ui-session__column ui-session__no-access" role="alert">
          <p>You don&apos;t have access to this session, or it doesn&apos;t exist.</p>
          <p className="ui-muted">Ask the person who sent the link to check it, or sign in with the account on their team.</p>
          {note && <p className="ui-muted">{note}</p>}
        </div>
      </div>
    </div>
  );
}

function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    // If the clipboard is blocked, the button stays as it was.
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    }).catch(() => {});
  }
  return (
    <button type="button" className="ui-btn" onClick={copy}>
      {copied ? "Link copied" : "Copy link"}
    </button>
  );
}

function Crumbs({ back, children }: { back?: ReactNode; children: ReactNode }) {
  return (
    <nav className="ui-session__crumbs" aria-label="Breadcrumb">
      <ColumnToggleButton where="main" />
      {back && (
        <>
          {back}
          <span aria-hidden="true" className="ui-muted">/</span>
        </>
      )}
      {children}
    </nav>
  );
}

/** Its own component, so the minute tick re-renders one word and not the stream. */
function StatusText({ session }: { session: LiveSession }) {
  return <>{displayStatus(session, useMinuteClock()).label}</>;
}

function LinkedSession({ link, onOpenSession, lead }: { link: LiveSessionLink; onOpenSession?: (id: string) => void; lead: string }) {
  const title = sessionTitle(link);
  return (
    <p className="ui-muted ui-session__notice">
      {lead}{" "}
      {onOpenSession ? <button type="button" className="ui-link" onClick={() => onOpenSession(link.id)}>{title}</button> : title}
    </p>
  );
}

/** A session that was cleared points to the one that took over, and the new one points back. */
function SessionLinks({ session, onOpenSession }: { session: LiveSession; onOpenSession?: (id: string) => void }) {
  return (
    <>
      {session.previous_session && <LinkedSession lead="Continues from" link={session.previous_session} onOpenSession={onOpenSession} />}
      {session.next_session && <LinkedSession lead="This conversation was cleared. Continued in" link={session.next_session} onOpenSession={onOpenSession} />}
    </>
  );
}

/** Same frame as the loaded session, so nothing moves when the first page arrives. */
function SessionPlaceholder({ back }: { back?: ReactNode }) {
  return (
    <div className="ui-session" aria-busy="true">
      <header className="ui-session__header">
        <Crumbs back={back}>
          <h1 className="ui-session__title">&nbsp;</h1>
        </Crumbs>
      </header>
      <div className="ui-session__scroll" />
    </div>
  );
}

/** One session: breadcrumb header, a stream that follows new messages, and a message box pinned below. */
export function SessionView(props: SessionViewProps) {
  return (
    <DataBoundary
      key={props.sessionId}
      fallback={<SessionPlaceholder back={props.back} />}
      errorMessage="Could not load this session."
      renderError={(error) => (error instanceof SessionNotFoundError ? <SessionNoAccess back={props.back} note={props.noAccessNote} /> : null)}
    >
      <LoadedSession {...props} />
    </DataBoundary>
  );
}

function LoadedSession({
  api,
  sessionId,
  back,
  menuItems,
  notice,
  onOpenSession,
  autoFocusComposer,
  track,
  entry = "list",
  shareBaseUrl,
  focusSeq = null,
}: SessionViewProps) {
  const { session, viewer, events, inputs: waiting, refresh } = useSessionStream(api, sessionId);
  const watchers = presenceLine(useSessionPresence(api, sessionId, viewer));
  const viewReported = useRef(false);
  useEffect(() => {
    if (viewReported.current) return;
    viewReported.current = true;
    // Routine runs are not shared sessions: counting them would inflate the view signal.
    if (session.session_type === "routine") return;
    track?.("session_viewed", { live_session_id: sessionId, is_owner: session.mine === true, entry });
    // Once per open: the view remounts for another session, and a poll never gets here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const inputs = useSessionInputs(api, sessionId, waiting, refresh, track);
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [confirming, setConfirming] = useState<SessionMenuItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const logItems = useMemo(() => buildStreamItems(events), [events]);
  const approvals = useMemo(() => openApprovals(logItems), [logItems]);
  const ownerName = session.owner_name ?? "the owner";
  const hostOffline = session.status === "host_offline";
  const viewerName = viewer.name;
  const items = useMemo(
    () => [...logItems, ...pendingItems(inputs.inputs, events, { viewerName, ownerName, hostOffline })],
    [logItems, inputs.inputs, events, viewerName, ownerName, hostOffline],
  );
  const needAttention = useMemo(() => inputs.inputs.filter((input) => input.state === "failed" || input.state === "uncertain"), [inputs.inputs]);

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
    scrollMemory.set(sessionId, near ? null : el.scrollTop);
  }, [sessionId]);

  useLayoutEffect(() => {
    const saved = scrollMemory.get(sessionId);
    if (saved == null || !scroller.current) return;
    following.current = false;
    scroller.current.scrollTop = saved;
  }, [sessionId]);

  useEffect(() => {
    if (following.current) jumpToLatest();
  }, [events.length, inputs.inputs.length, jumpToLatest]);

  const [highlightSeq, setHighlightSeq] = useState<number | null>(null);
  const wantedSeq = useRef<number | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A long session arrives in pages, so the linked message can show up after the first render.
  const scrollToWanted = useCallback(() => {
    const seq = wantedSeq.current;
    const target = seq === null ? null : scroller.current?.querySelector(`#${messageDomId(seq)}`);
    if (seq === null || !target) return;
    wantedSeq.current = null;
    following.current = false;
    target.scrollIntoView({ block: "center" });
    setHighlightSeq(seq);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightSeq(null), HIGHLIGHT_MS);
  }, []);
  useLayoutEffect(() => {
    wantedSeq.current = focusSeq;
    scrollToWanted();
    return () => clearTimeout(highlightTimer.current);
  }, [focusSeq, scrollToWanted]);
  useLayoutEffect(() => {
    scrollToWanted();
  }, [events.length, scrollToWanted]);

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

  const readOnly = session.session_type === "routine";
  const running = !readOnly && (session.status === "live" || session.status === "starting");
  const banner = sessionBanner(session);
  return (
    <div className="ui-session">
      <header className="ui-session__header">
        <Crumbs back={back}>
          <h1 className="ui-session__title">{sessionTitle(session)}</h1>
          <span className="ui-muted ui-session__meta">{readOnly ? "Routine run" : (session.owner_name ?? "Someone")} · <StatusText session={session} /></span>
          {watchers && <span className="ui-muted ui-session__presence" aria-live="polite">{watchers}</span>}
        </Crumbs>
        <div className="ui-session__actions">
          {running && (
            <button type="button" className="ui-btn" disabled={stopping} title="Stop (Esc in the message box)" onClick={() => void stop()}>
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
          {shareBaseUrl && <CopyLinkButton url={sessionUrl(shareBaseUrl, sessionId)} />}
          {menuItems && <SessionMenu items={menuItems(session)} onSelect={chooseMenuItem} />}
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
      {banner && <p className={`ui-session__banner ui-session__banner--${session.status === "host_offline" ? "offline" : "warning"}`} role="status">{banner}</p>}
      <SessionLinks session={session} onOpenSession={onOpenSession} />
      {actionError && <p className="ui-error ui-session__notice" role="alert">{actionError}</p>}
      {notice && <p className="ui-error ui-session__notice" role="alert">{notice}</p>}
      <div className="ui-session__scroll" ref={scroller} onScroll={onScroll}>
        <div className="ui-session__column">
          <SessionStream
            items={items}
            ownerName={session.owner_name ?? undefined}
            hostName={session.host_name}
            linkFor={shareBaseUrl ? (seq) => messageUrl(shareBaseUrl, sessionId, seq) : undefined}
            highlightSeq={highlightSeq}
          />
        </div>
      </div>
      {!atBottom && (
        <button type="button" className="ui-btn ui-session__jump" onClick={jumpToLatest} aria-label="Jump to latest message">↓</button>
      )}
      <div className="ui-session__footer">
        <div className="ui-session__column">
          {readOnly ? (
            <p className="ui-muted ui-session__notice">This run follows its routine on its own. It cannot take messages.</p>
          ) : (
            <>
            {session.status !== "ended" &&
              approvals.map((approval) => (
                <ApprovalPanel key={approval.requestId} approval={approval} hostName={session.host_name} onDecide={(requestId, decision) => api.decideApproval(sessionId, requestId, decision)} />
              ))}
            <SessionComposer {...inputs} inputs={needAttention} sessionId={sessionId} ownerName={ownerName} ended={session.status === "ended"} hostOffline={hostOffline} autoFocus={autoFocusComposer} onEmptyEscape={running && !stopping ? () => void stop() : undefined} folderName={session.folder_name} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

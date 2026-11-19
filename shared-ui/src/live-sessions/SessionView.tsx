"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { ApprovalPanel } from "./ApprovalPanel";
import { QuestionCard } from "./QuestionCard";
import { PlanCard } from "./PlanCard";
import { ModeMenu, nextMode, useSwitching } from "./ModeMenu";
import { shortName } from "./input-status";
import type { SessionEntry, TrackFn } from "../analytics/events";
import { DataBoundary } from "../query";
import { ColumnToggleButton } from "./SessionsLayout";
import { SessionComposer } from "./SessionComposer";
import { DisclosureState, revealPath, useSessionViewStates, viewStateKey } from "./view-state";
import { AgentTranscripts } from "./agent-transcript";
import { SessionStream } from "./SessionStream";
import { displayStatus } from "./display-status";
import { getHarness, harnessModes, type HarnessId } from "draft-core/harnesses";
import { SectionedPicker } from "../controls/SectionedPicker";
import { agentPickerSections, agentSummary } from "../controls/agent-picker";
import { useAgentDefaults, type AgentDefaultsLoader } from "./useAgentDefaults";
import { isPromptBlock } from "draft-core/live-sessions";
import { agentLabel } from "../routines/agent-label";
import { CheckIcon, LinkIcon } from "./MessageActions";
import { sessionBanner } from "./session-banner";
import { useMinuteClock } from "./useMinuteClock";
import { sessionTitle } from "./sessions-list";
import { relativeTime } from "../relative-time";
import { pendingItems } from "./pending-items";
import { buildStreamItems, openApprovals, type StreamItem } from "./stream-items";
import { presenceLine } from "./presence-line";
import { TeamStrip } from "./TeamStrip";
import { teamRoster, type TeamMember } from "./team-roster";
import { prependToDraft } from "./drafts";
import { useSessionInputs } from "./useSessionInputs";
import { useSessionPresence } from "./useSessionPresence";
import { useSessionStream, type SessionStreamState } from "./useSessionStream";
import { useLiveText } from "./useLiveText";
import { messageDomId, messageUrl, sessionUrl } from "./share-links";
import { SessionMenu, useSessionMenu, type SessionMenuItem } from "./SessionMenu";
import { SessionNotFoundError, type LiveSession, type LiveSessionLink, type LiveSessionsApi } from "./types";

const SKIPPED_MESSAGE = "The user skipped this.";

const STOPPING_MS = 3_000;
const HIGHLIGHT_MS = 2_000;
const COPIED_MS = 1_500;

const prefersReducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

interface SessionViewProps {
  api: LiveSessionsApi;
  sessionId: string;
  /** The "Sessions" crumb, for apps where the list is not always beside the session. */
  back?: ReactNode;
  menuItems?: (session: LiveSession) => SessionMenuItem[];
  /** Called after the owner deletes this session, so the app can leave it. */
  onDeleted?: (sessionId: string) => void;
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
  /** Show untested-version notices in development builds only. */
  devOnly?: boolean;
  /** Says what "Default" means for a harness on this computer. Only the desktop app can. */
  agentDefaults?: AgentDefaultsLoader;
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
    <button type="button" className="ui-btn ui-btn--icon" onClick={copy} aria-label={copied ? "Link copied" : "Copy link"} title={copied ? "Link copied" : "Copy link"}>
      {copied ? <CheckIcon /> : <LinkIcon />}
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

/** Where a cloud session runs and when its files were last backed up. Its own component, like StatusText. */
function CloudNote({ session }: { session: LiveSession }) {
  const now = useMinuteClock();
  const backup = session.raw_uploaded_at ? ` · Last backed up ${relativeTime(session.raw_uploaded_at, { now })}` : "";
  return <span className="ui-muted ui-session__meta">{`Draft cloud${backup}`}</span>;
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

function LoadedSession(props: SessionViewProps) {
  const stream = useSessionStream(props.api, props.sessionId);
  return <SessionContents key={stream.viewer.id} {...props} stream={stream} />;
}

function SessionContents({
  api,
  sessionId,
  back,
  menuItems,
  onDeleted,
  notice,
  onOpenSession,
  autoFocusComposer,
  track,
  entry = "list",
  shareBaseUrl,
  devOnly = false,
  agentDefaults,
  focusSeq = null,
  stream,
}: SessionViewProps & { stream: SessionStreamState }) {
  const { session, viewer, events, inputs: waiting, refresh } = stream;
  const history = stream.history;
  const viewStates = useSessionViewStates();
  const stateKey = viewStateKey(sessionId, viewer.id);
  const savedView = useMemo(() => {
    viewStates.setViewer(viewer.id);
    return viewStates.get(stateKey);
  }, [viewStates, stateKey, viewer.id]);
  const [expanded, setExpanded] = useState(savedView.expanded);
  const [agentTarget, setAgentTarget] = useState<number | null>(null);
  const navigationRequested = useRef<number | null>(null);
  const prependAnchor = useRef<{ id: string; top: number; before: number | null; overflowAnchor: string } | null>(null);
  const restoredAnchor = useRef(false);
  const olderRequest = useRef(false);
  const updateExpanded = useCallback((next: Readonly<Record<string, boolean>>) => {
    viewStates.get(stateKey).expanded = next;
    setExpanded(next);
  }, [viewStates, stateKey]);
  const changeDisclosure = useCallback((seq: string | number, open: boolean) => {
    setExpanded((current) => {
      const next = { ...current, [seq]: open };
      viewStates.get(stateKey).expanded = next;
      return next;
    });
  }, [viewStates, stateKey]);
  const disclosureState = useMemo(() => ({ expanded, change: changeDisclosure }), [expanded, changeDisclosure]);
  const linkFor = useCallback((seq: number) => messageUrl(shareBaseUrl ?? "", sessionId, seq), [shareBaseUrl, sessionId]);
  const watchers = presenceLine(useSessionPresence(api, sessionId, viewer));
  const viewReported = useRef(false);
  useEffect(() => {
    if (viewReported.current) return;
    if (session.session_type === "routine") {
      if (session.status !== "ended") return;
      viewReported.current = true;
      track?.("routine_result_viewed", { live_session_id: sessionId });
      return;
    }
    viewReported.current = true;
    track?.("session_viewed", { live_session_id: sessionId, is_owner: session.mine === true, entry });
  }, [session.session_type, session.status, session.mine, sessionId, track, entry]);
  const inputs = useSessionInputs(api, sessionId, waiting, refresh, track, stream.cacheKey);
  const { scrollRef, contentRef, scrollToBottom, stopScroll, isAtBottom, state: scrollState } = useStickToBottom({
    initial: "instant",
    resize: prefersReducedMotion() ? "instant" : undefined,
  });
  const discardPrepend = useCallback(() => {
    if (prependAnchor.current && scrollRef.current) scrollRef.current.style.overflowAnchor = prependAnchor.current.overflowAnchor;
    prependAnchor.current = null;
  }, [scrollRef]);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const logItems = useMemo(() => {
    const items = buildStreamItems(events);
    if (!stream.agents) return items;
    const included = new Set<string>();
    const mapped = items.map((item) => {
      if (item.type !== "tool") return item;
      const agent = stream.agents!.find((agent) => agent.hostSeq === item.seq);
      if (!agent) return item;
      included.add(agent.key);
      return { ...item, agent };
    });
    for (const agent of stream.agents) {
      if (included.has(agent.key) || (agent.hostSeq !== null && !events.some((e) => e.seq === agent.hostSeq))) continue;
      mapped.push({ type: "tool", seq: agent.hostSeq ?? agent.firstSeq, name: "Agent", summary: agent.description ?? "", input: null, result: null, agentId: null, agent });
    }
    return mapped.sort((a, b) => ("seq" in a ? a.seq : 0) - ("seq" in b ? b.seq : 0));
  }, [events, stream.agents, agentTarget]);
  const livePreviews = useLiveText(api, sessionId, stream.recentEvents, stream.readThrough);
  const liveText = useMemo(() => (session.status === "ended" ? [] : livePreviews), [session.status, livePreviews]);
  const approvals = useMemo(() => stream.approvals ? openApprovals(buildStreamItems(stream.approvals)) : openApprovals(logItems), [stream.approvals, logItems]);
  const team = useMemo(() => stream.agents ? stream.agents.filter((agent) => agent.name).map((agent) => ({
    name: agent.name!, state: agent.state, hostSeq: agent.hostSeq ?? agent.firstSeq, description: agent.description, model: agent.model, key: agent.key,
  })) : teamRoster(events), [events, stream.agents]);
  const ownerName = session.owner_name ?? "the owner";
  const harnessId = session.harness ?? "claude";
  const agentName = shortName(harnessId);
  // Only Claude runs in a pane the owner can open, and only its hook reads a reason for a denial.
  const hasTerminal = harnessId === "claude";
  const hostOffline = session.status === "host_offline";
  // A sleeping session has no run to take a decision, a mode or a model, so those controls wait for the next message.
  const sleeping = session.status === "sleeping";
  const viewerName = viewer.name;
  const items = useMemo<StreamItem[]>(
    () => [
      ...liveText.map((preview) => ({ type: "live" as const, messageId: preview.messageId, text: preview.text })),
      ...pendingItems(inputs.inputs, stream.recentEvents, { viewerName, ownerName, hostOffline }),
    ],
    [liveText, inputs.inputs, stream.recentEvents, viewerName, ownerName, hostOffline],
  );
  const needAttention = useMemo(() => inputs.inputs.filter((input) => input.state === "failed" || input.state === "uncertain"), [inputs.inputs]);

  const jumpToLatest = useCallback(() => {
    discardPrepend();
    history?.latest();
    setAgentTarget(null);
    wantedSeq.current = null;
    navigationRequested.current = null;
    restoreOffset.current = null;
    void scrollToBottom({ animation: prefersReducedMotion() ? "instant" : undefined });
  }, [scrollToBottom, history, discardPrepend]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const memory = viewStates.get(stateKey);
    memory.scroll = scrollState.isNearBottom ? null : el.scrollTop;
    if (memory.scroll === null) delete memory.anchor;
    else {
      const anchor = Array.from(el.querySelectorAll<HTMLElement>(".ui-stream > .ui-stream__item[id]")).find((row) => row.getBoundingClientRect().bottom > el.getBoundingClientRect().top);
      if (anchor) memory.anchor = { seq: Number(anchor.id.slice(2)), offset: anchor.getBoundingClientRect().top - el.getBoundingClientRect().top };
    }
  }, [viewStates, stateKey, scrollRef, scrollState]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const saved = savedView.scroll;
    if (saved == null) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    stopScroll();
    el.scrollTop = saved;
  }, [sessionId, savedView, scrollRef, stopScroll]);

  const [highlightSeq, setHighlightSeq] = useState<number | null>(null);
  const wantedSeq = useRef<number | null>(null);
  const restoreOffset = useRef<{ seq: number; offset: number } | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A long session arrives in pages, so the linked message can show up after the first render.
  const scrollToWanted = useCallback(() => {
    const seq = wantedSeq.current;
    if (seq === null) return;
    const path = revealPath(logItems, seq);
    if (!path) {
      const target = scrollRef.current?.querySelector(`#${messageDomId(seq)}`);
      if (target) {
        const details = target.firstElementChild;
        if (details?.tagName === "DETAILS" && !details.hasAttribute("open")) { changeDisclosure(seq, true); return; }
        wantedSeq.current = null;
        stopScroll();
        if (restoreOffset.current?.seq === seq && scrollRef.current) {
          scrollRef.current.scrollTop += target.getBoundingClientRect().top - scrollRef.current.getBoundingClientRect().top - restoreOffset.current.offset;
          restoreOffset.current = null;
        } else target.scrollIntoView({ block: "center" });
        setHighlightSeq(seq);
        clearTimeout(highlightTimer.current); highlightTimer.current = setTimeout(() => setHighlightSeq(null), HIGHLIGHT_MS);
        return;
      }
      if (history && navigationRequested.current !== seq) {
        navigationRequested.current = seq;
        discardPrepend();
        void history.focus(seq).then((target) => {
          if (target?.agentId) {
            changeDisclosure(`agent:${target.agentId}`, true);
            setAgentTarget(target.seq);
          }
        });
      }
      return;
    }
    if (path.some((parent) => expanded[parent] !== true)) {
      updateExpanded({ ...expanded, ...Object.fromEntries(path.map((parent) => [parent, true])) });
      return;
    }
    const target = scrollRef.current?.querySelector(`#${messageDomId(seq)}`);
    if (seq === null || !target) return;
    wantedSeq.current = null;
    stopScroll();
    if (restoreOffset.current?.seq === seq && scrollRef.current) {
      scrollRef.current.scrollTop += target.getBoundingClientRect().top - scrollRef.current.getBoundingClientRect().top - restoreOffset.current.offset;
      restoreOffset.current = null;
    } else target.scrollIntoView({ block: "center" });
    setHighlightSeq(seq);
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightSeq(null), HIGHLIGHT_MS);
  }, [scrollRef, stopScroll, logItems, expanded, updateExpanded, history, changeDisclosure, discardPrepend]);
  const showAgent = useCallback(
    (member: TeamMember) => {
      wantedSeq.current = member.hostSeq;
      scrollToWanted();
    },
    [scrollToWanted],
  );
  useLayoutEffect(() => {
    wantedSeq.current = focusSeq;
    navigationRequested.current = null;
  }, [focusSeq]);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);
  useLayoutEffect(() => {
    scrollToWanted();
  }, [events.length, scrollToWanted]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (prependAnchor.current && el && history?.before !== prependAnchor.current.before) {
      const anchor = el.querySelector<HTMLElement>(`#${prependAnchor.current.id}`);
      if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - prependAnchor.current.top;
      discardPrepend();
    }
    if (!history || restoredAnchor.current || focusSeq !== null) return;
    restoredAnchor.current = true;
    const anchor = savedView.anchor;
    if (!anchor) return;
    const restore = () => {
      const row = el?.querySelector<HTMLElement>(`#${messageDomId(anchor.seq)}`);
      if (row && el) { stopScroll(); el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset; }
    };
    if (events.some((e) => e.seq === anchor.seq)) restore();
    else { restoreOffset.current = anchor; wantedSeq.current = anchor.seq; navigationRequested.current = null; scrollToWanted(); }
  }, [events, history, focusSeq, savedView, scrollRef, stopScroll, scrollToWanted, discardPrepend]);

  const older = async () => {
    if (!history || history.loading || !history.hasOlder || olderRequest.current) return;
    olderRequest.current = true;
    const el = scrollRef.current;
    const anchor = Array.from(el?.querySelectorAll<HTMLElement>(".ui-stream > .ui-stream__item[id]") ?? []).find((row) => row.getBoundingClientRect().bottom > el!.getBoundingClientRect().top);
    stopScroll();
    if (anchor && el) {
      prependAnchor.current = { id: anchor.id, top: anchor.getBoundingClientRect().top, before: history.before, overflowAnchor: el.style.overflowAnchor };
      el.style.overflowAnchor = "none";
    }
    try { if (!await history.loadOlder()) discardPrepend(); }
    finally { olderRequest.current = false; }
  };
  const agentRuntime = useMemo(() => ({ api, sessionId, cacheKey: stream.cacheKey, target: agentTarget, mounted: scrollToWanted,
    linkFor: shareBaseUrl ? linkFor : undefined, harness: harnessId, ownerName, hostName: session.host_name,
    viewerId: viewer.id, viewerName, viewerIsOwner: session.mine ?? false,
  }), [api, sessionId, stream.cacheKey, agentTarget, scrollToWanted, shareBaseUrl, linkFor, harnessId, ownerName, session.host_name, viewer.id, viewerName, session.mine]);

  const stop = useCallback(async () => {
    setStopping(true);
    setActionError(null);
    try {
      const { withdrawn } = await api.stop(sessionId);
      prependToDraft(sessionId, withdrawn);
      if (withdrawn.length > 0) await refresh();
    } catch {
      setActionError("Could not send Stop. Try again.");
    }
    setTimeout(() => setStopping(false), STOPPING_MS);
  }, [api, sessionId, refresh]);

  const skipRequest = useCallback(
    (requestId: string) => api.decideApproval(sessionId, requestId, { decision: "deny", message: SKIPPED_MESSAGE }),
    [api, sessionId],
  );
  const openQuestions = useMemo(() => approvals.filter((a) => a.kind === "question"), [approvals]);
  const canAnswer = session.status !== "ended" && session.session_type !== "routine";
  // A new message replaces an open question, as typing over a prompt does in the terminal.
  const skipQuestions = useCallback(async () => void (await Promise.all(openQuestions.map((q) => skipRequest(q.requestId).catch(() => {})))), [openQuestions, skipRequest]);
  const sendMessage = useCallback(
    async (text: string) => {
      if (canAnswer && !sleeping) await skipQuestions();
      return inputs.send(text);
    },
    [canAnswer, sleeping, skipQuestions, inputs],
  );
  const modes = harnessModes(session.harness ?? "claude");
  const permissionSwitch = useSwitching(session.permission_mode);
  const approvalSwitch = useSwitching(session.approval_mode);
  const changeMode = useCallback(
    (change: { permissionMode?: string; approvalMode?: string }) => {
      setModeError(null);
      if (change.permissionMode) permissionSwitch.start(change.permissionMode);
      if (change.approvalMode) approvalSwitch.start(change.approvalMode);
      void api.setMode(sessionId, change).catch(() => {
        permissionSwitch.clear();
        approvalSwitch.clear();
        setModeError("Could not change the mode. Try again.");
      });
    },
    [api, sessionId, permissionSwitch.start, permissionSwitch.clear, approvalSwitch.start, approvalSwitch.clear],
  );
  const cycleMode = useCallback(() => {
    const next = permissionSwitch.target ? null : nextMode(modes.permission, session.permission_mode);
    if (next) changeMode({ permissionMode: next });
  }, [modes.permission, session.permission_mode, permissionSwitch.target, changeMode]);

  const showModes = canAnswer && !sleeping && (modes.permission.length > 0 || modes.approval.length > 0);
  const [pendingAgent, setPendingAgent] = useState<{ model: string | null; effort: string | null } | null>(null);
  const savedAgent = { model: session.model ?? null, effort: session.reasoning_effort ?? null };
  useEffect(() => {
    if (pendingAgent && pendingAgent.model === savedAgent.model && pendingAgent.effort === savedAgent.effort) setPendingAgent(null);
  }, [pendingAgent, savedAgent.model, savedAgent.effort]);
  useEffect(() => {
    if (!pendingAgent) return;
    const timer = setTimeout(() => setPendingAgent(null), 20_000);
    return () => clearTimeout(timer);
  }, [pendingAgent]);
  const agentDefaultsView = useAgentDefaults(agentDefaults, harnessId);
  const shownAgent = pendingAgent ?? savedAgent;
  const changeAgent = useCallback(
    (next: { model: string | null; effort: string | null }) => {
      setModeError(null);
      setPendingAgent(next);
      void api.setMode(sessionId, { model: next.model, reasoningEffort: next.effort }).catch(() => {
        setPendingAgent(null);
        setModeError("Could not change the model. Try again.");
      });
    },
    [api, sessionId],
  );
  // Only the owner's subscription pays for it, so only the owner changes the model and effort.
  const agentControl = canAnswer && !sleeping && session.mine === true && getHarness(harnessId) ? (
    <SectionedPicker
      label="Model and reasoning effort"
      align="start"
      direction="up"
      sections={agentPickerSections({ value: { harness: harnessId as HarnessId, ...shownAgent }, defaults: agentDefaultsView, harnesses: [], lockHarness: true, onChange: (next) => changeAgent({ model: next.model, effort: next.effort }) })}
    >
      {agentSummary(harnessId, shownAgent.model, shownAgent.effort, agentDefaultsView, false)}
    </SectionedPicker>
  ) : undefined;
  const modeControl = !showModes ? undefined : (
    <>
      {modes.permission.length > 0 && (
        <ModeMenu
          label="Mode"
          showLabel={modes.approval.length > 0}
          options={modes.permission}
          value={session.permission_mode ?? null}
          switchingTo={permissionSwitch.target || null}
          onSelect={(permissionMode) => changeMode({ permissionMode })}
        />
      )}
      {modes.approval.length > 0 && (
        <ModeMenu label="Approvals" showLabel options={modes.approval} value={session.approval_mode ?? null} switchingTo={approvalSwitch.target || null} onSelect={(approvalMode) => changeMode({ approvalMode })} />
      )}
      {modeError && <p className="ui-error ui-mode__error" role="alert">{modeError}</p>}
    </>
  );
  const hadOpen = useRef(false);
  useEffect(() => {
    if (approvals.length > 0) {
      hadOpen.current = true;
      return;
    }
    if (!hadOpen.current) return;
    hadOpen.current = false;
    const active = document.activeElement;
    // The card that held focus is gone, so focus goes back to the message box. Focus elsewhere stays.
    if (!active || active === document.body || active.closest(".ui-approval")) document.getElementById("session-message")?.focus();
  }, [approvals.length]);
  // Escape answers the first request, or dismisses a prompt, only while a run is there to take it.
  const awake = canAnswer && !sleeping;
  const firstOpenRequest = awake ? approvals[0] : undefined;
  // A prompt in the terminal that Draft shows no card for. Only the owner can dismiss it, and queued messages stay.
  const blockedByPrompt = awake && session.mine === true && !firstOpenRequest && inputs.inputs.some((i) => i.state === "queued" && isPromptBlock(i.reason));
  const dismissPrompt = useCallback(() => void api.stop(sessionId, { keepQueued: true }).then(() => refresh()).catch(() => setActionError("Could not dismiss the prompt. Try again.")), [api, sessionId, refresh]);
  useEffect(() => {
    if (!firstOpenRequest && !blockedByPrompt) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (firstOpenRequest) void skipRequest(firstOpenRequest.requestId).catch(() => {});
      else dismissPrompt();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [firstOpenRequest, blockedByPrompt, skipRequest, dismissPrompt]);

  const menu = useSessionMenu({ api, items: menuItems, onDeleted });

  // Only a computer can run a session again. A cloud session that failed to start has no run to bring back.
  const canResume = Boolean(api.resume) && session.mine === true && session.status === "ended" && session.runtime !== "cloud" && session.end_reason !== "cleared" && session.end_reason !== "start_failed" && session.end_reason !== "expired";
  const resume = useCallback(async () => {
    await api.resume?.(sessionId);
    await refresh();
  }, [api, sessionId, refresh]);

  const readOnly = session.session_type === "routine";
  const running = !readOnly && (session.status === "live" || session.status === "starting");
  const banner = sessionBanner(session, devOnly);
  return (
    <div className="ui-session">
      <header className="ui-session__header">
        <Crumbs back={back}>
          <div className="ui-session__heading">
            <h1 className="ui-session__title">{sessionTitle(session)}</h1>
            <span className="ui-muted ui-session__meta">
              {readOnly ? "Routine run" : (session.owner_name ?? "Someone")}{session.folder_name && <> · <span className="ui-session__folder">{session.folder_name}</span></>} · <StatusText session={session} />
              {watchers && <> · <span className="ui-session__presence" aria-live="polite">{watchers}</span></>}
            </span>
            <span className="ui-muted ui-session__meta ui-session__agent">{agentLabel({ harness: session.harness ?? "claude", model: session.model ?? null, effort: session.reasoning_effort ?? null })}</span>
            {session.runtime === "cloud" && <CloudNote session={session} />}
          </div>
        </Crumbs>
        <div className="ui-session__actions">
          {running && (
            <button type="button" className="ui-btn" disabled={stopping} title="Stop (Esc in the message box)" onClick={() => void stop()}>
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
          {shareBaseUrl && <CopyLinkButton url={sessionUrl(shareBaseUrl, sessionId)} />}
          <SessionMenu items={menu.itemsFor(session)} onSelect={menu.choose} />
        </div>
      </header>
      {menu.dialog}
      {stream.updateError && <p className="ui-muted ui-session__notice" role="status">{stream.updateError} <button type="button" className="ui-link" onClick={() => void refresh()}>Retry</button></p>}
      {banner && <p className={`ui-session__banner ui-session__banner--${session.status === "host_offline" ? "offline" : "warning"}`} role="status">{banner}</p>}
      <SessionLinks session={session} onOpenSession={onOpenSession} />
      {actionError && <p className="ui-error ui-session__notice" role="alert">{actionError}</p>}
      {notice && <p className="ui-error ui-session__notice" role="alert">{notice}</p>}
      <div className="ui-session__scroll" ref={scrollRef} onScroll={() => { onScroll(); if (history && scrollRef.current && scrollRef.current.scrollTop > 0 && scrollRef.current.scrollTop < 200) void older(); }}>
        <div className="ui-session__column" ref={contentRef}>
          {history?.hasOlder && <button type="button" className="ui-link" disabled={history.loading} onClick={() => void older()}>{history.loading ? "Loading…" : "Load older messages"}</button>}
          {history?.error && <p role="alert">{history.error} <button type="button" className="ui-link" onClick={() => { if (history.failedTarget !== null) { navigationRequested.current = null; scrollToWanted(); } else void older(); }}>Retry</button></p>}
          <AgentTranscripts.Provider value={agentRuntime}>
          <DisclosureState.Provider value={disclosureState}>
            <SessionStream
              items={logItems}
              liveItems={items}
              separateLive={history?.focused}
              ownerName={session.owner_name ?? undefined}
              hostName={session.host_name}
              viewerId={viewer.id}
              viewerName={viewer.name}
              viewerIsOwner={session.mine ?? false}
              harness={session.harness}
              onSteer={getHarness(session.harness ?? "claude")?.capabilities.steer ? (inputId) => void inputs.act(inputId, "steer").catch(() => {}) : undefined}
              onCancel={(inputId) => void inputs.act(inputId, "cancel").catch(() => {})}
              onShowRequest={() => document.querySelector<HTMLElement>(".ui-approval button")?.focus()}
              onDismissPrompt={blockedByPrompt ? dismissPrompt : undefined}
              onSkipQuestions={awake && openQuestions.length > 0 ? () => void skipQuestions() : undefined}
              linkFor={shareBaseUrl ? linkFor : undefined}
              highlightSeq={highlightSeq}
            />
          </DisclosureState.Provider>
          </AgentTranscripts.Provider>
        </div>
      </div>
      {(!isAtBottom || history?.focused) && (
        <button type="button" className="ui-btn ui-session__jump" onClick={jumpToLatest} aria-label="Jump to latest message">↓</button>
      )}
      <div className="ui-session__footer">
        <div className="ui-session__column">
          {session.status !== "ended" && <TeamStrip members={team} onShow={showAgent} />}
          {readOnly ? (
            <p className="ui-muted ui-session__notice">This run follows its routine on its own. It cannot take messages.</p>
          ) : (
            <>
            {session.status !== "ended" &&
              approvals.map((approval) =>
                approval.kind === "plan" && approval.plan ? (
                  <PlanCard key={approval.requestId} approval={approval} hostName={session.host_name} agent={agentName} sleeping={sleeping} onDecide={(requestId, response) => api.decideApproval(sessionId, requestId, response)} />
                ) : approval.kind === "question" && approval.questions.length > 0 ? (
                  <QuestionCard key={approval.requestId} approval={approval} hostName={session.host_name} agent={agentName} hasTerminal={hasTerminal} sleeping={sleeping} onSkip={skipRequest} onAnswer={(requestId, answers) => api.decideApproval(sessionId, requestId, { decision: "allow", answers })} />
                ) : (
                  <ApprovalPanel key={approval.requestId} approval={approval} hostName={session.host_name} agent={agentName} explainsDenial={hasTerminal} sleeping={sleeping} onDecide={(requestId, response) => api.decideApproval(sessionId, requestId, response)} />
                ),
              )}
            <SessionComposer {...inputs} send={sendMessage} modeControl={modeControl} onCycleMode={modes.permission.length > 0 && !sleeping ? cycleMode : undefined} inputs={needAttention} sessionId={sessionId} ownerName={ownerName} ended={session.status === "ended"} hostOffline={hostOffline} sleeping={sleeping} autoFocus={autoFocusComposer} onEmptyEscape={running && !stopping && approvals.length === 0 && !blockedByPrompt ? () => void stop() : undefined} agentControl={agentControl} onResume={canResume ? resume : undefined} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

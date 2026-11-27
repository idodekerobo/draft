"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { DataBoundary } from "../query/DataBoundary";
import { useDraftApi, useDraftTrack } from "../query/api";
import { queryKeys } from "../query/keys";
import { needsYouQueryOptions } from "../query/options";
import { toast } from "../toast";
import { GetStartedChecklist } from "./GetStartedChecklist";
import { NeedsYouRow, type RowHandlers } from "./NeedsYouRow";
import type { NotificationAction } from "./types";

const VISIBLE_ROWS = 3;
const UNDO_MS = 5_000;
const FRESH_MS = 10_000;
const COLLAPSE_KEY = "draft.home.needsYouCollapsed";

function readCollapsed(): boolean {
  try { return window.localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
}
function writeCollapsed(value: boolean) {
  try { window.localStorage.setItem(COLLAPSE_KEY, value ? "1" : "0"); } catch { /* storage can be blocked */ }
}

export interface NeedsYouPanelProps {
  workspaceId: string;
  onOpenSession: (sessionId: string) => void;
  onOpenRun: (runId: string) => void;
  onOpenConnections: () => void;
  onOpenRoutines: () => void;
  /** A notification id from an email link. Its row is marked and always visible. */
  highlightId?: string | null;
}

const DONE_MESSAGE: Record<NotificationAction, string> = { done: "Marked done", not_mine: "Marked not yours", undo: "Put back" };

function Rows({ workspaceId, highlightId, ...navigation }: NeedsYouPanelProps) {
  const api = useDraftApi();
  const track = useDraftTrack();
  const client = useQueryClient();
  const { data } = useSuspenseQuery(needsYouQueryOptions(api, workspaceId));
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [focusHeading, setFocusHeading] = useState(false);

  useEffect(() => setCollapsed(readCollapsed()), []);
  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current) return;
    viewed.current = true;
    track("home_viewed", { needs_you_count: data.count });
  }, [track, data.count]);
  useEffect(() => {
    if (!focusHeading) return;
    heading.current?.focus();
    setFocusHeading(false);
  }, [focusHeading]);

  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.needsYou(workspaceId) });

  async function act(id: string, action: NotificationAction) {
    setPending(id);
    try {
      const result = await api.actOnNotification(id, action);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      if (action === "undo") toast.success(DONE_MESSAGE.undo);
      else toast.success(DONE_MESSAGE[action], { duration: UNDO_MS, action: { label: "Undo", onClick: () => void act(id, "undo") } });
      if (action !== "undo") {
        setLeaving(id);
        await new Promise((resolve) => setTimeout(resolve, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 200));
      }
      setFocusHeading(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save that. Try again.");
    } finally {
      setPending(null);
      await refresh();
      setLeaving(null);
    }
  }

  async function decide(personId: string, rowId: string, decision: "approve" | "reject") {
    setPending(rowId);
    try {
      const result = await api.decidePerson(personId, decision);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      toast.success(decision === "approve" ? "Approved" : "Turned away");
      setLeaving(rowId);
      await new Promise((resolve) => setTimeout(resolve, window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 200));
      setFocusHeading(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save that. Try again.");
    } finally {
      setPending(null);
      await refresh();
      setLeaving(null);
    }
  }

  const handlers = (id: string): RowHandlers => ({
    onDecide: (personId, rowId, decision) => void decide(personId, rowId, decision),
    busy: pending === id,
    onDone: (notificationId) => void act(notificationId, "done"),
    onNotMine: (notificationId) => void act(notificationId, "not_mine"),
    onOpenSession: (sessionId) => { track("home_card_opened", { kind: "approval" }); navigation.onOpenSession(sessionId); },
    onOpenRun: (runId) => { track("home_card_opened", { kind: "input_request" }); navigation.onOpenRun(runId); },
    onOpenConnections: () => { track("home_card_opened", { kind: "connection_attention" }); navigation.onOpenConnections(); },
  });

  const showChecklist = Boolean(data.getStarted && !data.getStarted.firstTodo);
  const rowId = (row: (typeof data.rows)[number]) => (row.kind === "notification" ? row.notification.id : row.id);

  // While the pointer is over the list nothing moves under it: the rows hold still and come up to date when it leaves.
  const [hovered, setHovered] = useState(false);
  const held = useRef(data.rows);
  if (!hovered) held.current = data.rows;
  const allRows = hovered ? held.current : data.rows;

  // A row that appears or changes after the first load says so for a few seconds, so a change Draft made is not silent.
  const seen = useRef<Map<string, string> | null>(null);
  const [freshUntil, setFreshUntil] = useState<Record<string, number>>({});
  useEffect(() => {
    const signatures = new Map(data.rows.map((row) => [rowId(row), JSON.stringify(row)]));
    const previous = seen.current;
    seen.current = signatures;
    if (!previous) return;
    const changed = [...signatures].filter(([id, signature]) => previous.get(id) !== signature).map(([id]) => id);
    if (changed.length > 0) setFreshUntil((current) => ({ ...current, ...Object.fromEntries(changed.map((id) => [id, Date.now() + FRESH_MS])) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.rows]);
  useEffect(() => {
    if (hovered || Object.keys(freshUntil).length === 0) return;
    const timer = setTimeout(() => setFreshUntil((current) => Object.fromEntries(Object.entries(current).filter(([, until]) => until > Date.now()))), FRESH_MS);
    return () => clearTimeout(timer);
  }, [freshUntil, hovered]);
  const isFresh = (id: string) => (freshUntil[id] ?? 0) > Date.now();

  const shown = expanded ? allRows : allRows.slice(0, VISIBLE_ROWS);
  const linked = highlightId ? allRows.find((row) => rowId(row) === highlightId) : undefined;
  const rows = linked && !shown.includes(linked) ? [...shown, linked] : shown;
  const hidden = allRows.length - rows.length;

  return (
    <section className={`ui-home-panel${showChecklist ? " ui-home-panel--first-run" : ""}`} aria-labelledby="needs-you-title">
      <header className="ui-home-panel__header">
        <h2 id="needs-you-title" ref={heading} tabIndex={-1} className="ui-home-panel__title">
          Needs you{data.count > 0 && <span className="ui-home-panel__count">{data.count}</span>}
        </h2>
        {data.count > 0 && (
          <button
            type="button"
            className="ui-home-panel__toggle"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand Needs you" : "Collapse Needs you"}
            title={collapsed ? "Expand" : "Collapse"}
            onClick={() => { setCollapsed(!collapsed); writeCollapsed(!collapsed); }}
          >
            {collapsed ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronUp size={16} aria-hidden="true" />}
          </button>
        )}
      </header>
      <p className="ui-visually-hidden" role="status" aria-live="polite">{data.count === 0 ? "Nothing needs you." : `${data.count} need${data.count === 1 ? "s" : ""} you.`}</p>
      {data.partial && <p className="ui-error" role="alert">Some items didn't load. <button className="ui-link" type="button" onClick={() => void refresh()}>Retry</button></p>}
      {data.count === 0 && !data.partial && <p className="ui-muted">Nothing needs you right now.</p>}
      {!collapsed && data.count > 0 && (
        <>
          <ul className="ui-rows ui-home-rows" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
            {rows.map((row) => <NeedsYouRow key={`${row.kind}:${row.id}`} row={row} fresh={isFresh(rowId(row))} highlighted={rowId(row) === highlightId} leaving={leaving === rowId(row)} handlers={handlers(rowId(row))} />)}
          </ul>
          {hidden > 0 && <button type="button" className="ui-link ui-home-more" onClick={() => setExpanded(true)}>{hidden} more</button>}
          {expanded && allRows.length > VISIBLE_ROWS && <button type="button" className="ui-link ui-home-more" onClick={() => setExpanded(false)}>Show fewer</button>}
        </>
      )}
      {showChecklist && data.getStarted && <GetStartedChecklist facts={data.getStarted} onOpenConnections={navigation.onOpenConnections} onOpenRoutines={navigation.onOpenRoutines} />}
    </section>
  );
}

/** The pinned Needs you panel at the top of Home. */
export function NeedsYouPanel(props: NeedsYouPanelProps) {
  return (
    <DataBoundary
      fallback={<section className="ui-home-panel" aria-busy="true"><header className="ui-home-panel__header"><h2 className="ui-home-panel__title">Needs you</h2></header><p className="ui-muted" role="status">Loading…</p></section>}
      errorMessage="Couldn't load what needs you."
    >
      <Rows {...props} />
    </DataBoundary>
  );
}

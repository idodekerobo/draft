"use client";

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
  const shown = expanded ? data.rows : data.rows.slice(0, VISIBLE_ROWS);
  const linked = highlightId ? data.rows.find((row) => rowId(row) === highlightId) : undefined;
  const rows = linked && !shown.includes(linked) ? [...shown, linked] : shown;
  const hidden = data.rows.length - rows.length;

  return (
    <section className={`ui-activity-section ui-home-panel${showChecklist ? " ui-home-panel--first-run" : ""}`} aria-labelledby="needs-you-title">
      <h2 id="needs-you-title" ref={heading} tabIndex={-1} className="ui-activity-section-title">
        Needs you{data.count > 0 ? ` (${data.count})` : ""}
        {data.count > 0 && (
          <button type="button" className="ui-link" aria-expanded={!collapsed} onClick={() => { setCollapsed(!collapsed); writeCollapsed(!collapsed); }}>{collapsed ? "Show" : "Hide"}</button>
        )}
      </h2>
      <p className="ui-visually-hidden" role="status" aria-live="polite">{data.count === 0 ? "Nothing needs you." : `${data.count} need${data.count === 1 ? "s" : ""} you.`}</p>
      {data.partial && <p className="ui-error" role="alert">Some items didn't load. <button className="ui-link" type="button" onClick={() => void refresh()}>Retry</button></p>}
      {data.count === 0 && !data.partial && <p className="ui-muted">Nothing needs you right now.</p>}
      {!collapsed && data.count > 0 && (
        <>
          <ul className="ui-rows">
            {rows.map((row) => <NeedsYouRow key={`${row.kind}:${row.id}`} row={row} highlighted={rowId(row) === highlightId} leaving={leaving === rowId(row)} handlers={handlers(rowId(row))} />)}
          </ul>
          {hidden > 0 && <button type="button" className="ui-link" onClick={() => setExpanded(true)}>{hidden} more</button>}
          {expanded && data.rows.length > VISIBLE_ROWS && <button type="button" className="ui-link" onClick={() => setExpanded(false)}>Show fewer</button>}
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
      fallback={<section className="ui-activity-section" aria-busy="true"><h2 className="ui-activity-section-title">Needs you</h2><p className="ui-muted" role="status">Loading…</p></section>}
      errorMessage="Couldn't load what needs you."
    >
      <Rows {...props} />
    </DataBoundary>
  );
}

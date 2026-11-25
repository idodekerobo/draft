"use client";

import { useEffect, useRef, useState } from "react";

/** Shape of one row from GET /workspaces/:id/synthesis-runs. */
export interface SynthesisRunSummary {
  id: string;
  kind?: "interactive" | "routine" | "synthesis" | "summarization";
  sessionId?: string | null;
  routineId?: string | null;
  routineTitle?: string | null;
  routineKind?: "once" | "rule" | null;
  createdRoutines?: Array<{ id: string; title: string; kind: "once" | "recurring" | "event" }>;
  status: string;
  outcome: "changed" | "no_change" | "failure" | "stale" | null;
  triggerType: string | null;
  resultSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** How many step runs the run started. Zero or missing for a run that has no steps. */
  stepCount?: number;
}

/** A one-time routine that has not run yet. Mirrors backend UpcomingRoutine. */
export interface UpcomingRoutine {
  id: string;
  title: string;
  runAt: string;
  timezone: string;
  setBy: { type: "person"; name: string } | { type: "routine"; routineId: string; title: string };
}

/** Shape of GET /workspaces/:id/synthesis-runs. upcoming and upcomingError come on the first page only. */
export interface ActivityHistoryEntry {
  id: string;
  type: string;
  summary: string;
  occurredAt: string;
  visibility: "shared" | "private";
}

export interface SynthesisRunsPage {
  runs: SynthesisRunSummary[];
  /** Notification history in this page's time window. Older servers omit it. */
  events?: ActivityHistoryEntry[];
  nextCursor: string | null;
  upcoming?: UpcomingRoutine[];
  upcomingError?: true;
}

type RunState = "in_progress" | "succeeded" | "failed";

const IN_PROGRESS = new Set(["queued", "preparing", "running", "validating", "committing"]);

export function runState(run: SynthesisRunSummary): RunState {
  if (IN_PROGRESS.has(run.status)) return "in_progress";
  return run.status === "succeeded" ? "succeeded" : "failed";
}

const STATE_LABEL: Record<RunState, string> = { succeeded: "Completed", in_progress: "In progress", failed: "Failed" };

const STATE_DOT: Record<RunState, string> = { succeeded: "connected", in_progress: "pending", failed: "error" };

const OUTCOME_LABEL: Record<NonNullable<SynthesisRunSummary["outcome"]>, string> = {
  changed: "Context updated",
  no_change: "No changes",
  failure: "Failed",
  stale: "Stale",
};

function primaryLine(run: SynthesisRunSummary): string {
  if (run.kind === "routine") return `${run.routineTitle ?? "Routine"} · routine`;
  if (run.kind === "summarization") return "Summarization";
  if (run.kind === "interactive") return "Interactive session";
  const trigger = run.triggerType ? `${run.triggerType[0]!.toUpperCase()}${run.triggerType.slice(1).replace(/_/g, " ")} synthesis` : "Synthesis";
  const state = runState(run);
  return `${trigger}, ${run.outcome ? OUTCOME_LABEL[run.outcome].toLowerCase() : state === "in_progress" ? "in progress" : state}`;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function formatDuration(run: SynthesisRunSummary): string | null {
  if (!run.startedAt || !run.completedAt) return null;
  const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)}s` : null;
}

export function ActivityList({ runs, onFixInConnections, onOpenRun, onOpenSteps, focusStepsFor, onOpenRoutine, onOpenCreatedOnce, onRunAgain, runningRoutineId }: {
  runs: SynthesisRunSummary[];
  onFixInConnections: () => void;
  onOpenRun?: (sessionId: string) => void;
  /** Opens a run's steps. The button shows only for a run that has steps. */
  onOpenSteps?: (runId: string) => void;
  /** The run whose steps were just closed. Its button takes focus back. */
  focusStepsFor?: string | null;
  onOpenRoutine?: (routineId: string) => void;
  onOpenCreatedOnce?: (routineId: string) => void;
  onRunAgain?: (routineId: string) => void;
  runningRoutineId?: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const stepButtons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    if (focusStepsFor) stepButtons.current.get(focusStepsFor)?.focus();
  }, [focusStepsFor]);
  if (runs.length === 0) return <p className="ui-muted">No activity yet. Draft will list your workspace runs here.</p>;

  return (
    <ul className="ui-rows">
      {runs.map((run) => {
        const state = runState(run);
        const open = openId === run.id;
        const meta = [run.kind === "routine" ? STATE_LABEL[state] : null, formatWhen(run.startedAt ?? run.createdAt), formatDuration(run), state === "failed" ? run.resultSummary : null].filter(Boolean).join(", ");
        return (
          <li key={run.id} className="ui-activity-row">
            <button type="button" className="ui-activity-row__main" aria-expanded={open} onClick={() => setOpenId(open ? null : run.id)}>
              <span className={`ui-dot ui-dot--${STATE_DOT[state]}`} aria-hidden="true" />
              <span className="ui-activity-row__text">
                <span className="ui-activity-row__primary">{primaryLine(run)}</span>
                <span className="ui-activity-row__meta">{meta}</span>
              </span>
            </button>
            <div className="ui-activity-row__actions">
              {state === "failed" && run.kind !== "routine" && (
                <button type="button" className="ui-link ui-activity-row__action" onClick={onFixInConnections}>Fix in Connections</button>
              )}
              {!!run.stepCount && onOpenSteps && (
                <button type="button" ref={(element) => { if (element) stepButtons.current.set(run.id, element); else stepButtons.current.delete(run.id); }} className="ui-link ui-activity-row__action" aria-label={`View steps of ${primaryLine(run)}`} onClick={() => onOpenSteps(run.id)}>View steps</button>
              )}
              {run.kind === "routine" && run.sessionId && onOpenRun && (
                <button type="button" className="ui-link ui-activity-row__action" onClick={() => onOpenRun(run.sessionId!)}>Open run</button>
              )}
              {run.routineKind === "once" && run.routineId && onRunAgain && (
                <button type="button" className="ui-link ui-activity-row__action" disabled={!!runningRoutineId} aria-busy={runningRoutineId === run.routineId} aria-label={`Run ${run.routineTitle ?? "routine"} again`} onClick={() => onRunAgain(run.routineId!)}>{runningRoutineId === run.routineId ? "Starting…" : "Run again"}</button>
              )}
            </div>
            {!!run.createdRoutines?.length && (
              <div className="ui-activity-row__created">
                {run.createdRoutines.map((routine) => (
                  <p key={routine.id}><span className="ui-activity-row__created-label">Created</span> {routine.kind === "once" && onOpenCreatedOnce ? <button type="button" className="ui-link" onClick={() => onOpenCreatedOnce(routine.id)}>{routine.title}</button> : onOpenRoutine ? <button type="button" className="ui-link" onClick={() => onOpenRoutine(routine.id)}>{routine.title}</button> : routine.title}</p>
                ))}
              </div>
            )}
            {open && (
              <dl className="ui-activity-row__detail">
                <dt>Started</dt><dd>{formatWhen(run.startedAt ?? run.createdAt)}</dd>
                <dt>Duration</dt><dd>{formatDuration(run) ?? (state === "in_progress" ? "Still running" : "Unavailable")}</dd>
                <dt>Result</dt><dd>{run.resultSummary ?? (run.outcome ? OUTCOME_LABEL[run.outcome] : "Pending")}</dd>
              </dl>
            )}
          </li>
        );
      })}
    </ul>
  );
}

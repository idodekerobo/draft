"use client";

import { useState } from "react";

/** Shape of one row from GET /workspaces/:id/synthesis-runs. */
export interface SynthesisRunSummary {
  id: string;
  status: string;
  outcome: "changed" | "no_change" | "failure" | "stale" | null;
  triggerType: string | null;
  resultSummary: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

type RunState = "in_progress" | "succeeded" | "failed";

const IN_PROGRESS = new Set(["queued", "preparing", "running", "validating", "committing"]);

export function runState(run: SynthesisRunSummary): RunState {
  if (IN_PROGRESS.has(run.status)) return "in_progress";
  return run.status === "succeeded" ? "succeeded" : "failed";
}

const STATE_DOT: Record<RunState, string> = { succeeded: "connected", in_progress: "pending", failed: "error" };

const OUTCOME_LABEL: Record<NonNullable<SynthesisRunSummary["outcome"]>, string> = {
  changed: "Context updated",
  no_change: "No changes",
  failure: "Failed",
  stale: "Stale",
};

function primaryLine(run: SynthesisRunSummary): string {
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

export function ActivityList({ runs, onFixInConnections }: { runs: SynthesisRunSummary[]; onFixInConnections: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (runs.length === 0) return <p className="ui-muted">No activity yet. Draft will list synthesis runs here.</p>;

  return (
    <ul className="ui-rows">
      {runs.map((run) => {
        const state = runState(run);
        const open = openId === run.id;
        const meta = [formatWhen(run.startedAt ?? run.createdAt), formatDuration(run), state === "failed" ? run.resultSummary : null].filter(Boolean).join(", ");
        return (
          <li key={run.id} className="ui-activity-row">
            <button type="button" className="ui-activity-row__main" aria-expanded={open} onClick={() => setOpenId(open ? null : run.id)}>
              <span className={`ui-dot ui-dot--${STATE_DOT[state]}`} aria-hidden="true" />
              <span className="ui-activity-row__text">
                <span className="ui-activity-row__primary">{primaryLine(run)}</span>
                <span className="ui-activity-row__meta">{meta}</span>
              </span>
            </button>
            {state === "failed" && (
              <button type="button" className="ui-link ui-activity-row__fix" onClick={onFixInConnections}>Fix in Connections</button>
            )}
            {open && (
              <dl className="ui-activity-row__detail">
                <dt>Started</dt><dd>{formatWhen(run.startedAt ?? run.createdAt)}</dd>
                <dt>Duration</dt><dd>{formatDuration(run) ?? "Still running"}</dd>
                <dt>Result</dt><dd>{run.resultSummary ?? (run.outcome ? OUTCOME_LABEL[run.outcome] : "Pending")}</dd>
              </dl>
            )}
          </li>
        );
      })}
    </ul>
  );
}

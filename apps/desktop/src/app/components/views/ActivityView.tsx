// ActivityView.tsx — cloud synthesis run history

import { useState } from "react";
import { DataBoundary, useRuns } from "draft-shared-ui";
import type { WorkspaceRun } from "../../../rpc/schema";
import { useWorkspaceKey } from "../../DesktopQueryProvider";

// ── Format helpers ─────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
  const day = d.getDate();
  const time = d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${month} ${day} AT ${time}`;
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return "";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  return (ms / 1000).toFixed(1) + "s";
}

// ── Status → display mapping ─────────────────────────────────────────────────
// synthesis_runs.status is a 9-state lifecycle; the tab only needs three
// visual buckets: still working, finished cleanly, or finished badly.

type DisplayStatus = "in_progress" | "succeeded" | "failed";

const IN_PROGRESS_STATUSES: ReadonlySet<WorkspaceRun["status"]> =
  new Set(["queued", "preparing", "running", "validating", "committing"]);

function displayStatus(run: WorkspaceRun): DisplayStatus {
  if (IN_PROGRESS_STATUSES.has(run.status)) return "in_progress";
  if (run.status === "succeeded") return "succeeded";
  return "failed"; // failed, stale, cancelled
}

// Reuses the existing activity-run__dot / __badge color classes (success =
// green, skipped = yellow, failed/timeout = red) rather than adding new CSS.
const DOT_COLOR: Record<DisplayStatus, string> = {
  succeeded:   "var(--color-status-green)",
  in_progress: "var(--color-status-yellow)",
  failed:      "var(--color-status-red)",
};

const BADGE_CLASS: Record<DisplayStatus, string> = {
  succeeded:   "activity-run__badge--success",
  in_progress: "activity-run__badge--skipped",
  failed:      "activity-run__badge--failed",
};

const BADGE_LABEL: Record<DisplayStatus, string> = {
  succeeded:   "Succeeded",
  in_progress: "In progress",
  failed:      "Failed",
};

const OUTCOME_LABELS: Record<NonNullable<WorkspaceRun["outcome"]>, string> = {
  changed:    "Context updated",
  no_change:  "No changes",
  failure:    "Failed",
  stale:      "Stale",
};

function outcomeLabel(run: WorkspaceRun): string | null {
  return run.outcome ? OUTCOME_LABELS[run.outcome] : null;
}

// ── Empty state ────────────────────────────────────────────────────────────────

function ActivityEmptyPrompt() {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">◎</div>
      <p className="empty-state__title">No activity yet</p>
      <p className="empty-state__body">Sandbox synthesis runs will show up here.</p>
    </div>
  );
}

// ── Accordion detail ───────────────────────────────────────────────────────────

function ActivityRunDetail({ run }: { run: WorkspaceRun }) {
  const status = displayStatus(run);

  return (
    <div className="activity-run__detail">
      <div className="activity-run__detail-top">
        <span className={`activity-run__badge ${BADGE_CLASS[status]}`}>
          {BADGE_LABEL[status]}
        </span>
        {outcomeLabel(run) && (
          <span className="activity-run__detail-desc">{outcomeLabel(run)}</span>
        )}
      </div>
      {run.resultSummary && (
        <span className="activity-run__project-path">{run.resultSummary}</span>
      )}
    </div>
  );
}

// ── Run row ────────────────────────────────────────────────────────────────────

function ActivityRunRow({ run }: { run: WorkspaceRun }) {
  const [expanded, setExpanded] = useState(false);
  const status = displayStatus(run);

  const primaryLine = outcomeLabel(run) ?? BADGE_LABEL[status];

  const ts = run.startedAt ? formatTimestamp(run.startedAt) : formatTimestamp(run.createdAt);
  const dur = formatDuration(run.startedAt, run.completedAt);
  const metaLine = [ts, dur].filter(Boolean).join(" · ");

  return (
    <div className={`activity-run${expanded ? " activity-run--expanded" : ""}`}>
      <button
        className="activity-run__row"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span
          className="activity-run__dot"
          style={{ background: DOT_COLOR[status] }}
        />
        <span className="activity-run__content">
          <span className="activity-run__primary">{primaryLine}</span>
          <span className="activity-run__meta">{metaLine}</span>
        </span>
        <span className={`activity-run__chevron${expanded ? " activity-run__chevron--expanded" : ""}`}>▶</span>
      </button>
      {expanded && <ActivityRunDetail run={run} />}
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────────────────────

function ActivityRuns() {
  // The desktop DraftApi returns full WorkspaceRun rows.
  const runs = useRuns(useWorkspaceKey()).data as WorkspaceRun[];
  if (runs.length === 0) return <ActivityEmptyPrompt />;
  return (
    <div className="activity__list">
      {runs.map((run) => (
        <ActivityRunRow key={run.id} run={run} />
      ))}
    </div>
  );
}

export function ActivityView() {
  return (
    <div className="activity">
      <div className="activity__header">
        <h1 className="ui-page__title">Activity</h1>
        <p className="ui-page__intro">How your workspace context changes over time.</p>
      </div>

      <div className="activity__body">
        <DataBoundary
          fallback={<div className="activity__loading">Loading…</div>}
          errorFallback={(retry) => (
            <div className="activity__error">
              Could not load activity. <button type="button" className="ui-link" onClick={retry}>Try again</button>
            </div>
          )}
        >
          <ActivityRuns />
        </DataBoundary>
      </div>
    </div>
  );
}

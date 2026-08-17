// ActivityView.tsx — cloud synthesis run history

import { useState, useEffect, useRef } from "react";
import type { WorkspaceRun } from "../../../rpc/schema";
import { events, rpc } from "../../rpc";

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

const POLL_INTERVAL_MS = 30_000;

export function ActivityView() {
  const [runs, setRuns]       = useState<WorkspaceRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const isMounted             = useRef(true);

  async function refresh() {
    try {
      const next = await rpc.request.getWorkspaceRuns();
      if (!isMounted.current) return;
      setRuns(next);
      setError(null);
    } catch {
      if (!isMounted.current) return;
      setError("Could not load activity.");
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }

  useEffect(() => {
    isMounted.current = true;
    void refresh();

    const offProfile = events.on("profileChanged", () => void refresh());

    function onVisibility() {
      if (document.visibilityState === "visible") void refresh();
    }
    document.addEventListener("visibilitychange", onVisibility);

    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);

    return () => {
      isMounted.current = false;
      offProfile();
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="activity">
      <div className="activity__header">
        <span className="activity__title">Activity</span>
      </div>

      <div className="activity__body">
        {error && (
          <div className="activity__error">{error}</div>
        )}

        {!error && loading && (
          <div className="activity__loading">Loading…</div>
        )}

        {!error && !loading && runs.length === 0 && (
          <ActivityEmptyPrompt />
        )}

        {!error && !loading && runs.length > 0 && (
          <div className="activity__list">
            {runs.map((run) => (
              <ActivityRunRow key={run.id} run={run} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

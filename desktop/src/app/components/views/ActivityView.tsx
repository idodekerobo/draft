// ActivityView.tsx — synthesis run history

import { useState, useEffect, useRef } from "react";
import type { ActivityRun } from "../../../rpc/schema";
import { events, rpc } from "../../rpc";

// ── Format helpers ─────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
  const day = d.getDate();
  const time = d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${month} ${day} AT ${time}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  return (ms / 1000).toFixed(1) + "s";
}

function cwdShort(cwd: string | null): string {
  if (!cwd) return "";
  const parts = cwd.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return cwd;
  return parts.slice(-2).join("/");
}

const DOT_COLOR: Record<ActivityRun["status"], string> = {
  success: "var(--color-status-green)",
  skipped: "var(--color-status-yellow)",
  failed:  "var(--color-status-red)",
  timeout: "var(--color-status-red)",
};

const SKIP_REASON_LABELS: Record<string, string> = {
  other:                        "Session ended early",
  clear:                        "Session cleared",
  resume:                       "Session resumed",
  logout:                       "User logged out",
  bypass_permissions_disabled:  "Permissions mode changed",
  unknown:                      "Session ended unexpectedly",
};

const ERROR_LABELS: Record<string, string> = {
  "invalid job JSON":           "Invalid session data",
  "timed out after 300s":       "Synthesis timed out",
};

function friendlySkipReason(raw: string | null): string {
  if (!raw) return "Session skipped";
  return SKIP_REASON_LABELS[raw] ?? "Session skipped";
}

function friendlyError(raw: string | null): string {
  if (!raw) return "Something went wrong";
  if (ERROR_LABELS[raw]) return ERROR_LABELS[raw];
  if (raw.startsWith("adapter exited")) return "Synthesis failed";
  if (raw.startsWith("source adapter not found")) return "Synthesis not configured";
  return "Something went wrong";
}

// ── Empty state ────────────────────────────────────────────────────────────────

function ActivityEmptyPrompt() {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">◎</div>
      <p className="empty-state__title">No activity yet</p>
      <p className="empty-state__body">Draft will log synthesis runs here.</p>
    </div>
  );
}

// ── Accordion detail ───────────────────────────────────────────────────────────

function ActivityRunDetail({ run }: { run: ActivityRun }) {
  const rows: { label: string; value: string }[] = [];

  rows.push({ label: "Source", value: run.source });
  if (run.cwd) rows.push({ label: "Directory", value: run.cwd });

  if (run.status === "success") {
    if (run.durationMs !== null) rows.push({ label: "Duration", value: formatDuration(run.durationMs) });
    rows.push({ label: "Proposals", value: String(run.proposalsGenerated) });
  } else if (run.status === "skipped") {
    rows.push({ label: "Reason", value: friendlySkipReason(run.skipReason) });
  } else if (run.status === "failed") {
    if (run.durationMs !== null) rows.push({ label: "Duration", value: formatDuration(run.durationMs) });
    rows.push({ label: "Error", value: friendlyError(run.errorMsg) });
  } else if (run.status === "timeout") {
    rows.push({ label: "Error", value: friendlyError("timed out after 300s") });
  }

  if (run.sessionId) rows.push({ label: "Session", value: run.sessionId });

  return (
    <div className="activity-run__detail">
      {rows.map(({ label, value }) => (
        <div key={label} className="activity-run__detail-row">
          <span className="activity-run__detail-label">{label}</span>
          <span className="activity-run__detail-value">{value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Run row ────────────────────────────────────────────────────────────────────

function ActivityRunRow({ run }: { run: ActivityRun }) {
  const [expanded, setExpanded] = useState(false);

  const primaryRight = cwdShort(run.cwd);
  const primaryLine = primaryRight
    ? `${run.source} · ${primaryRight}`
    : run.source;

  let metaLine: string;
  const ts = formatTimestamp(run.startedAt);

  if (run.status === "success") {
    const dur = formatDuration(run.durationMs);
    const prop = run.proposalsGenerated === 1
      ? "1 proposal"
      : `${run.proposalsGenerated} proposals`;
    metaLine = [ts, dur, prop].filter(Boolean).join(" · ");
  } else if (run.status === "skipped") {
    metaLine = `${ts} · ${friendlySkipReason(run.skipReason)}`;
  } else if (run.status === "failed") {
    metaLine = `${ts} · ${friendlyError(run.errorMsg)}`;
  } else {
    metaLine = `${ts} · ${friendlyError("timed out after 300s")}`;
  }

  return (
    <div className={`activity-run${expanded ? " activity-run--expanded" : ""}`}>
      <button
        className="activity-run__row"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span
          className="activity-run__dot"
          style={{ background: DOT_COLOR[run.status] }}
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
  const [runs, setRuns]       = useState<ActivityRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const isMounted             = useRef(true);

  async function refresh() {
    try {
      const next = await rpc.request.getActivityRuns();
      if (!isMounted.current) return;
      setRuns(next);
      setError(null);
    } catch {
      if (!isMounted.current) return;
      setError("Could not load activity — check daemon.log");
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

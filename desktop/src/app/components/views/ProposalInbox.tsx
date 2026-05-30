// ProposalInbox.tsx — proposal panel with contextual empty states
//
// Shows one of four states per DESIGN.md, in priority order:
//   State 1 — Daemon not running (heartbeat stale or stopped)
//   State 2 — No integrations connected (Phase 2: reads secrets.json)
//   State 3 — Running + integrations, no proposals yet
//   State 4 — Normal proposal list (Phase 2)
//
// State 2 detection is deferred to Phase 2 (requires reading secrets.json).
// For now we jump from State 1 → State 3.
//
// Copy rule per DESIGN.md: never use the word "daemon" in UI text.

import type { DaemonStatus } from "../../../rpc/schema";

// ── Empty state components ──────────────────────────────────────────────────────

function State1DaemonStopped({ onStart }: { onStart: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">⬤</div>
      <p className="empty-state__title">Draft isn't running</p>
      <p className="empty-state__body">Your context isn't being captured.</p>
      <button className="empty-state__cta" onClick={onStart}>
        Start Draft
      </button>
    </div>
  );
}

function State3Watching() {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">◎</div>
      <p className="empty-state__title">Draft is watching</p>
      <p className="empty-state__body">
        Proposals will appear here when the daemon captures something new.
      </p>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────────

interface ProposalInboxProps {
  status: DaemonStatus | null;
  onStartDraft: () => void;
}

function isDaemonStopped(status: DaemonStatus | null): boolean {
  if (!status) return true;
  return status.state === "stopped";
}

export function ProposalInbox({ status, onStartDraft }: ProposalInboxProps) {
  const stopped = isDaemonStopped(status);

  return (
    <div className="proposals">
      <div className="proposals__header">
        <span className="proposals__title">Proposals</span>
      </div>

      <div className="proposals__list">
        {stopped ? (
          <State1DaemonStopped onStart={onStartDraft} />
        ) : (
          // State 3: running, no proposals yet
          // State 4 (actual proposal list) wired in Phase 2
          <State3Watching />
        )}
      </div>
    </div>
  );
}

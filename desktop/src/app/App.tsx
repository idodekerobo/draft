// App.tsx — root React component
//
// Owns:
//   - Status polling loop (getStatus RPC every 5s)
//   - Active view state (sidebar navigation)
//   - Proposal count state (Phase 2: from fs.watch push; Phase 1: stub 0)
//
// Two-panel layout: sidebar (left) + content (right).
// Status bar always visible above both panels.

import { useState, useEffect } from "react";
import type { DaemonStatus } from "../rpc/schema";
import { events, rpc } from "./rpc";
import { StatusBar } from "./components/StatusBar";
import { Sidebar, type View } from "./components/Sidebar";
import { ProposalInbox } from "./components/views/ProposalInbox";

// ── Polling interval ───────────────────────────────────────────────────────────
const STATUS_POLL_MS = 5_000;

// ── App ────────────────────────────────────────────────────────────────────────

export function App() {
  const [status, setStatus]           = useState<DaemonStatus | null>(null);
  const [activeView, setActiveView]   = useState<View>("proposals");
  const [proposalCount, setProposalCount] = useState(0); // Phase 2: driven by badgeUpdate push

  // ── Status polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const s = await rpc.request.getStatus();
        if (!cancelled) setStatus(s);
      } catch {
        // RPC not yet ready (app just launched) — stay in null/loading state
      }
    }

    void poll();
    const id = setInterval(() => void poll(), STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ── Push updates from main-process watchers ───────────────────────────────
  useEffect(() => {
    return events.on("badgeUpdate", ({ count }) => setProposalCount(count));
  }, []);

  // ── Start Draft handler ────────────────────────────────────────────────────
  // Phase 3: will wire to launchSession RPC. For now: no-op (daemon is started
  // via CLI: `draft start`). The button still gives the user the right mental
  // model — they need to start Draft.
  function handleStartDraft() {
    // TODO Phase 3: rpc.request.launchSession({ tool: "claude-code", profile: status?.profile ?? "default" })
    console.info("[draft-desktop] Start Draft — wire to daemon start in Phase 3");
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <StatusBar status={status} />

      <div className="layout">
        <Sidebar
          activeView={activeView}
          onNavigate={setActiveView}
          proposalCount={proposalCount}
        />

        <main className="content">
          {activeView === "proposals" && (
            <ProposalInbox
              status={status}
              onStartDraft={handleStartDraft}
              onCountChange={setProposalCount}
            />
          )}
          {activeView === "sessions" && (
            <div className="panel-placeholder">Sessions — Phase 3</div>
          )}
          {activeView === "context" && (
            <div className="panel-placeholder">Context viewer — Phase 4</div>
          )}
          {activeView === "settings" && (
            <div className="panel-placeholder">Settings — Phase 5</div>
          )}
        </main>
      </div>
    </div>
  );
}

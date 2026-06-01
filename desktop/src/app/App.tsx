// App.tsx — root React component
//
// Owns:
//   - Status polling loop (getStatus RPC every 5s)
//   - Active view state (sidebar navigation)
//   - Active profile state (updated by profileChanged events + switchProfile RPC)
//   - Profile list (loaded on mount, refreshed on profileChanged)
//   - Proposal badge count (from badgeUpdate push; filtered by active profile)
//   - Daemon start state + error toast (auto-dismissing)

import { useState, useEffect, useRef } from "react";
import type { DaemonStatus } from "../rpc/schema";
import { events, rpc } from "./rpc";
import { StatusBar } from "./components/StatusBar";
import { Sidebar, type View } from "./components/Sidebar";
import { ProposalInbox } from "./components/views/ProposalInbox";
import { ContextViewer } from "./components/views/ContextViewer";
import { DaemonStoppedOverlay } from "./components/DaemonStoppedOverlay";

// ── Polling interval ───────────────────────────────────────────────────────────
const STATUS_POLL_MS = 5_000;

// ── App ────────────────────────────────────────────────────────────────────────

export function App() {
  const [status, setStatus]             = useState<DaemonStatus | null>(null);
  const [activeView, setActiveView]     = useState<View>("proposals");
  const [proposalCount, setProposalCount] = useState(0);
  const [activeProfile, setActiveProfile] = useState<string>("");
  const [profiles, setProfiles]         = useState<string[]>([]);
  const [isStarting, setIsStarting]     = useState(false);
  const [startError, setStartError]     = useState<string | null>(null);
  // Blue dot on Context sidebar item — set by ContextViewer when loadDiff finds new entries.
  // Cleared when the user navigates to the Context tab.
  const [contextHasNew, setContextHasNew] = useState(false);

  // Ref so event handlers always see the current profile without re-registering.
  const activeProfileRef = useRef(activeProfile);
  useEffect(() => { activeProfileRef.current = activeProfile; }, [activeProfile]);

  // ── Shared status fetch ────────────────────────────────────────────────────
  // Called by both the poll interval and handleStartDraft (for an immediate
  // refresh after a daemon start, without waiting up to 5s for the next tick).
  async function fetchStatus() {
    const s = await rpc.request.getStatus();
    setStatus(s);
    // Seed activeProfile from status on first load only.
    if (!activeProfileRef.current && s.appState.activeProfile) {
      setActiveProfile(s.appState.activeProfile);
    }
  }

  // ── Status polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        if (!cancelled) await fetchStatus();
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

  // ── Load profile list ──────────────────────────────────────────────────────
  async function loadProfiles() {
    try {
      const pl = await rpc.request.getProfiles();
      setProfiles(pl.names);
      // Also sync active profile in case it diverged.
      if (pl.active) setActiveProfile(pl.active);
    } catch {
      // Non-fatal — profile list stays empty; chip shows current name only.
    }
  }

  useEffect(() => { void loadProfiles(); }, []);

  // ── Push: badge updates (filtered by active profile) ──────────────────────
  useEffect(() => {
    return events.on("badgeUpdate", ({ profile, count }) => {
      if (profile === activeProfileRef.current) setProposalCount(count);
    });
  }, []);

  // ── Push: profile changed (CLI-driven or desktop-driven) ──────────────────
  useEffect(() => {
    return events.on("profileChanged", ({ profile }) => {
      setActiveProfile(profile);
      setProposalCount(0); // Clear badge — new profile's watcher will push the real count.
      void loadProfiles();  // Refresh list in case a new profile was created.
    });
  }, []);

  // ── Start error auto-dismiss ───────────────────────────────────────────────
  useEffect(() => {
    if (!startError) return;
    const id = setTimeout(() => setStartError(null), 4_000);
    return () => clearTimeout(id);
  }, [startError]);

  // ── Daemon start ───────────────────────────────────────────────────────────
  // startDaemon RPC fires start.sh and returns immediately (avoids Electrobun's
  // short renderer-side RPC timeout racing start.sh's internal sleep).
  // We poll getStatus() here in the renderer — each call is fast, no timeout risk.
  async function handleStartDraft() {
    setIsStarting(true);
    try {
      await rpc.request.startDaemon();

      const POLL_MS    = 500;
      const TIMEOUT_MS = 20_000;
      const deadline   = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, POLL_MS));
        const s = await rpc.request.getStatus();
        setStatus(s);
        if (s.state !== "stopped") return; // UI already updated via setStatus
      }
      setStartError("Daemon did not start. Check ~/.draft/background/logs/daemon-error.log");
    } catch {
      setStartError("Failed to start Draft.");
    } finally {
      setIsStarting(false);
    }
  }

  // ── Profile switch ─────────────────────────────────────────────────────────
  async function handleSwitchProfile(profile: string) {
    try {
      const result = await rpc.request.switchProfile({ profile });
      if (result.ok && result.active) {
        setActiveProfile(result.active);
        setProposalCount(0);
      }
    } catch {
      // Non-fatal — current profile remains active.
    }
  }

  function handleNavigate(view: View) {
    if (view === "context") setContextHasNew(false);
    setActiveView(view);
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <StatusBar
        status={status}
        activeProfile={activeProfile}
        profiles={profiles}
        onSwitchProfile={handleSwitchProfile}
      />

      <div className="layout">
        <Sidebar
          activeView={activeView}
          onNavigate={handleNavigate}
          proposalCount={proposalCount}
          contextHasNew={contextHasNew}
        />

        <main className="content">
          {/* Settings is always reachable regardless of daemon state. */}
          {activeView === "settings" ? (
            <div className="panel-placeholder">Settings — Phase 5</div>
          ) : status?.state === "stopped" ? (
            <DaemonStoppedOverlay onStart={handleStartDraft} isStarting={isStarting} />
          ) : (
            <>
              {activeView === "proposals" && (
                <ProposalInbox
                  key={activeProfile}
                  activeProfile={activeProfile}
                  onCountChange={setProposalCount}
                />
              )}
              {activeView === "sessions" && (
                <div className="panel-placeholder">Sessions — Phase 3</div>
              )}
              {activeView === "context" && (
                <ContextViewer
                  key={activeProfile}
                  activeProfile={activeProfile}
                  onNewChanges={setContextHasNew}
                />
              )}
            </>
          )}
        </main>
      </div>
      {startError && (
        <div className="toast toast--error" role="alert">
          <span>{startError}</span>
          <button className="toast__dismiss" onClick={() => setStartError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
    </div>
  );
}

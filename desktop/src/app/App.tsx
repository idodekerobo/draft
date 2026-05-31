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
  // startDaemon RPC polls until the daemon is confirmed running (or 8s timeout),
  // so result.ok is a reliable signal — no race-window guesswork needed here.
  async function handleStartDraft() {
    setIsStarting(true);
    try {
      const result = await rpc.request.startDaemon();
      if (result.ok) {
        try { await fetchStatus(); } catch {}
      } else {
        setStartError(result.error ?? "Failed to start Draft.");
      }
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
          onNavigate={setActiveView}
          proposalCount={proposalCount}
        />

        <main className="content">
          {activeView === "proposals" && (
            <ProposalInbox
              key={activeProfile}
              status={status}
              activeProfile={activeProfile}
              isStartingDraft={isStarting}
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
      {startError && (
        <div className="toast toast--error" role="alert">
          <span>{startError}</span>
          <button className="toast__dismiss" onClick={() => setStartError(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
    </div>
  );
}

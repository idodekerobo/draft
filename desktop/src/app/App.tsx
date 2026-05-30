// App.tsx — root React component
//
// Owns:
//   - Status polling loop (getStatus RPC every 5s)
//   - Active view state (sidebar navigation)
//   - Active profile state (updated by profileChanged events + switchProfile RPC)
//   - Profile list (loaded on mount, refreshed on profileChanged)
//   - Proposal badge count (from badgeUpdate push; filtered by active profile)

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

  // Ref so event handlers always see the current profile without re-registering.
  const activeProfileRef = useRef(activeProfile);
  useEffect(() => { activeProfileRef.current = activeProfile; }, [activeProfile]);

  // ── Status polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const s = await rpc.request.getStatus();
        if (!cancelled) {
          setStatus(s);
          // Seed activeProfile from status on first load only.
          if (!activeProfileRef.current && s.appState.activeProfile) {
            setActiveProfile(s.appState.activeProfile);
          }
        }
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

  // ── Daemon start ───────────────────────────────────────────────────────────
  async function handleStartDraft() {
    try {
      await rpc.request.startDaemon();
    } catch {
      // Status poll will surface any failure via the next getStatus call.
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

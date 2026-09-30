// App.tsx — root React component
//
// Owns:
//   - Status polling loop (getStatus RPC every 5s, for appState only)
//   - Active view state (sidebar navigation)
//   - Active profile state (updated by profileChanged events + switchProfile RPC)
//   - Profile list (loaded on mount, refreshed on profileChanged)
//
// Server data lives in the query cache; see hooks/ and queries.ts.

import { useState, useEffect, useRef, useCallback, startTransition } from "react";
import { events, rpc } from "./rpc";
import { useAnalytics } from "./analytics/AnalyticsContext";
import { useUserIdentity } from "./identity/UserIdentityContext";
import { StatusBar } from "./components/StatusBar";
import type { View } from "./types";
import { Sidebar } from "./components/Sidebar";
import { ContextViewer } from "./components/views/ContextViewer";
import { SettingsView } from "./components/views/SettingsView";
import { ActivityView } from "./components/views/ActivityView";
import { ConnectionsView } from "./components/views/ConnectionsView";
import { DesktopOnboarding } from "./components/views/onboarding/DesktopOnboarding";
import { SupportPanel } from "./components/SupportPanel";
import { useCrispChat } from "./support/useCrispChat";
import { useAppUpdates, type Toast } from "./hooks/useAppUpdates";
import { useBootstrapPolling } from "./hooks/useBootstrapPolling";
import { useContextFiles } from "./hooks/useContextFiles";

// ── Polling interval ───────────────────────────────────────────────────────────
const STATUS_POLL_MS = 5_000;

// ── App ────────────────────────────────────────────────────────────────────────

export function App() {
  const [activeView, setActiveView]     = useState<View>("context");
  const [activeProfile, setActiveProfile] = useState<string>("");
  const [profiles, setProfiles]         = useState<string[]>([]);
  // Latch: set true the instant onboarding's "Let's go" fires, so the main
  // app renders immediately instead of waiting on identityRefreshNeeded's
  // async round trip to land before identity.onboardingCompletedAt updates.
  const [justCompletedOnboarding, setJustCompletedOnboarding] = useState(false);
  const [syncToast, setSyncToast] = useState<Toast | null>(null);
  const [supportOpen, setSupportOpen]           = useState(false);
  const landedRef = useRef(false);
  const sawEmptyContextRef = useRef(false);
  const identity = useUserIdentity();
  const { workspaceId, hydrated: identityHydrated } = identity;
  const workspaceIdRef = useRef(workspaceId);
  const { messages: crispMessages, sendMessage: crispSend, isReady: crispReady } = useCrispChat();
  const { files: contextFiles, loading: contextLoading, settled: contextSettled, setFiles: setContextFiles, reloadFiles: reloadContextFiles } = useContextFiles();
  const updates = useAppUpdates();

  const { track } = useAnalytics();
  const hasLaunchedRef = useRef(false);

  // Ref so event handlers always see the current profile without re-registering.
  const activeProfileRef = useRef(activeProfile);
  useEffect(() => { activeProfileRef.current = activeProfile; }, [activeProfile]);
  useEffect(() => { workspaceIdRef.current = workspaceId; }, [workspaceId]);

  // ── Shared status fetch ────────────────────────────────────────────────────
  async function fetchStatus() {
    const s = await rpc.request.getStatus();
    // Seed activeProfile from status on first load only.
    if (!activeProfileRef.current && s.appState.activeProfile) {
      setActiveProfile(s.appState.activeProfile);
    }
    if (!hasLaunchedRef.current) {
      hasLaunchedRef.current = true;
      track("app_launched", { user_state: s.appState.userState });
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
  const loadProfiles = useCallback(async () => {
    try {
      const pl = await rpc.request.getProfiles();
      setProfiles(pl.names);
      // Also sync active profile in case it diverged.
      if (pl.active) setActiveProfile(pl.active);
    } catch {
      // Non-fatal — profile list stays empty; chip shows current name only.
    }
  }, []);

  useEffect(() => { void loadProfiles(); }, [loadProfiles]);

  const contextEmpty = contextSettled && contextFiles.length === 0;

  // On launch, land on Connections when the workspace has no context yet.
  useEffect(() => {
    if (landedRef.current || !contextSettled || !identity.onboardingCompletedAt) return;
    landedRef.current = true;
    if (contextEmpty) setActiveView("connections");
  }, [contextSettled, contextEmpty, identity.onboardingCompletedAt]);

  // Notify once when an empty workspace gets its first context. The query polls while empty.
  useEffect(() => {
    if (!contextSettled) return;
    if (contextEmpty) {
      sawEmptyContextRef.current = true;
      return;
    }
    if (sawEmptyContextRef.current) {
      sawEmptyContextRef.current = false;
      rpc.send.sendNotification({ title: "Your team's context is ready", subtitle: "", body: "Open Draft to read it." });
    }
  }, [contextSettled, contextEmpty]);

  // ── Push: profile changed (CLI-driven or desktop-driven) ──────────────────
  useEffect(() => {
    return events.on("profileChanged", ({ profile }) => {
      setActiveProfile(profile);
      void loadProfiles();  // Refresh list in case a new profile was created.
    });
  }, [loadProfiles]);

  useBootstrapPolling(workspaceIdRef, setContextFiles, setSyncToast);

  useEffect(() => {
    if (!syncToast) return;
    const id = setTimeout(() => setSyncToast(null), 5_000);
    return () => clearTimeout(id);
  }, [syncToast]);

  // ── Profile switch ─────────────────────────────────────────────────────────
  const handleSwitchProfile = useCallback(async (profile: string) => {
    try {
      const result = await rpc.request.switchProfile({ profile });
      if (result.ok && result.active) {
        setActiveProfile(result.active);
      }
    } catch {
      // Non-fatal — current profile remains active.
    }
  }, []);

  // A transition keeps the current view on screen if the next one has to wait.
  const handleNavigate = useCallback((view: View) => {
    startTransition(() => setActiveView(view));
    track("view_navigated", { view });
  }, [track]);

  const openFeedback = useCallback(() => setSupportOpen(true), []);

  const settingsOpen = activeView === "settings";
  const showOnboarding = identityHydrated && !justCompletedOnboarding && (!identity.signedIn || !identity.onboardingCompletedAt);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <StatusBar />

      <div className="layout">
        <Sidebar
          activeView={activeView}
          onNavigate={handleNavigate}
          activeProfile={activeProfile}
          profiles={profiles}
          onSwitchProfile={handleSwitchProfile}
          onOpenFeedback={openFeedback}
        />

        <main className="content">
          {/* Settings is always reachable regardless of daemon state. */}
          {settingsOpen && (
            <SettingsView key={activeProfile} activeProfile={activeProfile} onOpenFeedback={openFeedback} />
          )}
          {!settingsOpen && !identityHydrated && <div className="empty-state">Loading…</div>}
          {!settingsOpen && showOnboarding && (
            <DesktopOnboarding
              files={contextFiles}
              loading={contextLoading}
              reloadFiles={reloadContextFiles}
              onComplete={async (destination) => {
                setJustCompletedOnboarding(true);
                await reloadContextFiles();
                // Land on Context when documents exist, otherwise Connections.
                setActiveView(destination === "connections" || contextFiles.length === 0 ? "connections" : "context");
              }}
            />
          )}
          {identityHydrated && !showOnboarding && (
            <>
              {/* Stays mounted so the selected document and tree state survive tab changes. */}
              <div className="content__view" hidden={activeView !== "context"}>
                <ContextViewer
                  key={`${activeProfile}:${workspaceId ?? "signed-out"}`}
                  activeProfile={activeProfile}
                  files={contextFiles}
                  setFiles={setContextFiles}
                  reloadFiles={reloadContextFiles}
                  loading={contextLoading}
                />
              </div>
              {activeView === "connections" && <ConnectionsView key={activeProfile} />}
              {activeView === "activity" && <ActivityView key={activeProfile} />}
            </>
          )}
        </main>
      </div>
      {updates.updateReady && updates.updateVersion && (
        <div className="update-pill" role="status">
          <span className="update-pill__text">New update available</span>
          <button
            className="update-pill__later"
            onClick={updates.dismissUpdatePill}
          >
            Later
          </button>
          <button
            className="update-pill__cta"
            onClick={() => void updates.applyUpdate()}
            disabled={updates.isApplyingUpdate}
          >
            {updates.isApplyingUpdate ? "Installing…" : "Install Now"}
          </button>
        </div>
      )}
      {updates.updateToast && (
        <div className={`toast toast--${updates.updateToast.type}`} role={updates.updateToast.type === "error" ? "alert" : "status"}>
          <span>{updates.updateToast.msg}</span>
          <button className="toast__dismiss" onClick={updates.dismissUpdateToast} aria-label="Dismiss">✕</button>
        </div>
      )}
      {syncToast && (
        <div className={`toast toast--${syncToast.type}`} role={syncToast.type === "error" ? "alert" : "status"}>
          <span>{syncToast.msg}</span>
          <button className="toast__dismiss" onClick={() => setSyncToast(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
      <SupportPanel
        isOpen={supportOpen}
        onClose={() => setSupportOpen(false)}
        messages={crispMessages}
        sendMessage={crispSend}
        isReady={crispReady}
      />
    </div>
  );
}

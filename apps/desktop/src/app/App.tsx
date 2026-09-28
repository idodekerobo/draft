// App.tsx — root React component
//
// Owns:
//   - Status polling loop (getStatus RPC every 5s, for appState only)
//   - Active view state (sidebar navigation)
//   - Active profile state (updated by profileChanged events + switchProfile RPC)
//   - Profile list (loaded on mount, refreshed on profileChanged)

import { useState, useEffect, useRef, useCallback } from "react";
import type { ContextFileEntry } from "../rpc/schema";
import { events, rpc } from "./rpc";
import { useAnalytics } from "./analytics/AnalyticsContext";
import { useUserIdentity } from "./identity/UserIdentityContext";
import { StatusBar } from "./components/StatusBar";
import type { View } from "./types";
import { Sidebar } from "./components/Sidebar";
import { ContextViewer } from "./components/views/ContextViewer";
import { SettingsView } from "./components/views/SettingsView";
import { ActivityView } from "./components/views/ActivityView";
import { OnboardingView } from "./components/views/OnboardingView";
import { SupportPanel } from "./components/SupportPanel";
import { useCrispChat } from "./support/useCrispChat";

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
  const [updateReady, setUpdateReady]       = useState(false);
  const [updateVersion, setUpdateVersion]   = useState<string | null>(null);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);
  const [updateToast, setUpdateToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [syncToast, setSyncToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const bootstrapPollRef = useRef<{ cancelled: boolean } | null>(null);
  const [supportOpen, setSupportOpen]           = useState(false);
  const [contextSnapshot, setContextSnapshot] = useState<{ workspaceId: string | null; files: ContextFileEntry[] }>({ workspaceId: null, files: [] });
  const [contextLoading, setContextLoading] = useState(false);
  const contextRequestRef = useRef(0);
  const identity = useUserIdentity();
  const { workspaceId, hydrated: identityHydrated, signedIn } = identity;
  const workspaceIdRef = useRef(workspaceId);
  const signedInRef = useRef(signedIn);
  const { messages: crispMessages, sendMessage: crispSend, isReady: crispReady } = useCrispChat();

  const { track } = useAnalytics();
  const hasLaunchedRef = useRef(false);

  // Ref so event handlers always see the current profile without re-registering.
  const activeProfileRef = useRef(activeProfile);
  useEffect(() => { activeProfileRef.current = activeProfile; }, [activeProfile]);

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

  useEffect(() => { workspaceIdRef.current = workspaceId; }, [workspaceId]);
  useEffect(() => { signedInRef.current = signedIn; }, [signedIn]);

  const reloadContextFiles = useCallback(async () => {
    const requestedWorkspaceId = workspaceIdRef.current;
    if (!requestedWorkspaceId || !signedInRef.current) return;
    const requestId = ++contextRequestRef.current;
    try {
      const files = await rpc.request.getContextFiles();
      if (requestId === contextRequestRef.current && workspaceIdRef.current === requestedWorkspaceId) {
        setContextSnapshot({ workspaceId: requestedWorkspaceId, files });
        setContextLoading(false);
      }
    } catch {
      if (requestId === contextRequestRef.current && workspaceIdRef.current === requestedWorkspaceId) {
        setContextSnapshot({ workspaceId: requestedWorkspaceId, files: [] });
        setContextLoading(false);
      }
    }
  }, []);

  // Keying the snapshot by cloud workspace prevents ui flicker while new request is in flight
  useEffect(() => {
    contextRequestRef.current += 1;
    setContextSnapshot({ workspaceId, files: [] });
    setContextLoading(Boolean(workspaceId && signedIn));
    if (workspaceId && signedIn) void reloadContextFiles();
  }, [workspaceId, signedIn, reloadContextFiles]);

  // ── Push: profile changed (CLI-driven or desktop-driven) ──────────────────
  useEffect(() => {
    return events.on("profileChanged", ({ profile }) => {
      setActiveProfile(profile);
      void loadProfiles();  // Refresh list in case a new profile was created.
    });
  }, []);

  // ── Bootstrap synthesis run polling ───────────────────────────────────────
  useEffect(() => {
    return events.on("bootstrapRunStarted", () => {
      if (bootstrapPollRef.current) bootstrapPollRef.current.cancelled = true; // supersede any earlier poll
      const token = { cancelled: false };
      bootstrapPollRef.current = token;
      const startedForWorkspaceId = workspaceIdRef.current;

      const POLL_MS = 10_000;
      const TIMEOUT_MS = 10 * 60_000;
      const deadline = Date.now() + TIMEOUT_MS;

      void (async () => {
        while (!token.cancelled && workspaceIdRef.current === startedForWorkspaceId && Date.now() < deadline) {
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
          if (token.cancelled || workspaceIdRef.current !== startedForWorkspaceId) return;
          let files: ContextFileEntry[];
          try {
            files = await rpc.request.getContextFiles();
          } catch {
            continue;
          }
          if (token.cancelled || workspaceIdRef.current !== startedForWorkspaceId) return;
          if (files.length > 0) {
            await reloadContextFiles();
            setSyncToast({ type: "success", msg: "Your workspace context is ready." });
            return;
          }
        }
        if (!token.cancelled && workspaceIdRef.current === startedForWorkspaceId) {
          setSyncToast({ type: "error", msg: "Still setting up your workspace — check the Context tab again shortly." });
        }
      })();
    });
  }, [reloadContextFiles]);

  useEffect(() => {
    return () => { if (bootstrapPollRef.current) bootstrapPollRef.current.cancelled = true; };
  }, []);

  useEffect(() => {
    if (!syncToast) return;
    const id = setTimeout(() => setSyncToast(null), 5_000);
    return () => clearTimeout(id);
  }, [syncToast]);

  // ── Update events ──────────────────────────────────────────────────────────
  useEffect(() => {
    const unsubs = [
      events.on("updateAvailable", ({ version }) => {
        setUpdateVersion(version);
        setUpdateReady(true);
      }),
      events.on("updateNotAvailable", () => {
        setUpdateToast({ type: "success", msg: "Draft is up to date" });
      }),
      events.on("updateCheckFailed", ({ error }) => {
        setUpdateToast({ type: "error", msg: error });
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  useEffect(() => {
    if (!updateToast) return;
    const id = setTimeout(() => setUpdateToast(null), 3_500);
    return () => clearTimeout(id);
  }, [updateToast]);

  async function handleApplyUpdate() {
    setIsApplyingUpdate(true);
    try {
      await rpc.request.applyUpdate();
      // App restarts — this line is usually not reached.
    } catch {
      setUpdateToast({ type: "error", msg: "Failed to apply update. Try again." });
      setIsApplyingUpdate(false);
    }
  }

  // ── Profile switch ─────────────────────────────────────────────────────────
  async function handleSwitchProfile(profile: string) {
    try {
      const result = await rpc.request.switchProfile({ profile });
      if (result.ok && result.active) {
        setActiveProfile(result.active);
      }
    } catch {
      // Non-fatal — current profile remains active.
    }
  }

  function handleNavigate(view: View) {
    setActiveView(view);
    track("view_navigated", { view });
  }

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
          onOpenFeedback={() => setSupportOpen(true)}
        />

        <main className="content">
          {/* Settings is always reachable regardless of daemon state. */}
          {activeView === "settings" ? (
            <SettingsView key={activeProfile} activeProfile={activeProfile} onOpenFeedback={() => setSupportOpen(true)} />
          ) : !identityHydrated ? (
            <div className="empty-state">Loading…</div>
          ) : !justCompletedOnboarding && (!identity.signedIn || !identity.onboardingCompletedAt) ? (
            <OnboardingView onComplete={async () => { setJustCompletedOnboarding(true); await fetchStatus(); await reloadContextFiles(); }} />
          ) : (
            <>
              {activeView === "context" && (
                !identityHydrated ? <div className="empty-state">Loading workspace…</div> :
                <ContextViewer
                  key={`${activeProfile}:${workspaceId ?? "signed-out"}`}
                  activeProfile={activeProfile}
                  files={contextSnapshot.workspaceId === workspaceId ? contextSnapshot.files : []}
                  setFiles={(update) => setContextSnapshot((snapshot) => ({
                    workspaceId,
                    files: typeof update === "function"
                      ? update(snapshot.workspaceId === workspaceId ? snapshot.files : [])
                      : update,
                  }))}
                  reloadFiles={reloadContextFiles}
                  loading={contextLoading || contextSnapshot.workspaceId !== workspaceId}
                />
              )}
              {activeView === "activity" && (
                <ActivityView key={activeProfile} />
              )}
            </>
          )}
        </main>
      </div>
      {updateReady && updateVersion && (
        <div className="update-pill" role="status">
          <span className="update-pill__text">New update available</span>
          <button
            className="update-pill__later"
            onClick={() => setUpdateReady(false)}
          >
            Later
          </button>
          <button
            className="update-pill__cta"
            onClick={() => void handleApplyUpdate()}
            disabled={isApplyingUpdate}
          >
            {isApplyingUpdate ? "Installing…" : "Install Now"}
          </button>
        </div>
      )}
      {updateToast && (
        <div className={`toast toast--${updateToast.type}`} role={updateToast.type === "error" ? "alert" : "status"}>
          <span>{updateToast.msg}</span>
          <button className="toast__dismiss" onClick={() => setUpdateToast(null)} aria-label="Dismiss">✕</button>
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

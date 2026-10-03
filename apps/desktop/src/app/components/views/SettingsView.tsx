// SettingsView.tsx — user-configurable settings
//
// Sections (top → bottom):
//   System     — Draft Cloud sign-in, notifications, synthesis schedule
//   Privacy    — usage data and session replay, stored on the account
//   Appearance — Light, Dark, System
//   Updates    — current version, check for updates
//
// Sources and tools live in ConnectionsView.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { LocalConfig, SynthesisSchedule } from "../../../rpc/schema";
import { events, rpc } from "../../rpc";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { AppearanceRow, DataBoundary, PrivacyRows, THEME_STORAGE_KEY, Toggle, applyTheme, isThemePreference, queryKeys, useOptimisticMutation, useSuspenseQuery, type ThemePreference } from "draft-shared-ui";
import { useWorkspaceKey } from "../../DesktopQueryProvider";
import { useCloudSignIn } from "../../hooks/useCloudSignIn";
import { appVersionQueryOptions, crispConfigQueryOptions, localConfigQueryOptions, synthesisScheduleQueryOptions } from "../../queries";

// ── Helpers ────────────────────────────────────────────────────────────────────

// Only one cadence is offered today (see register-workspace-synthesis.ts); falls
// back to the raw cron/interval if a workspace ever has something else.
function describeSynthesisCadence(schedule: SynthesisSchedule): string {
  if (schedule.scheduleKind === "cron" && schedule.cronExpression === "0 0,4,8,9-18,22 * * *") {
    return "Hourly, 9am–6pm UTC; every ~4h overnight";
  }
  if (schedule.scheduleKind === "interval" && schedule.intervalSeconds) {
    return `Every ${Math.round(schedule.intervalSeconds / 60)} minutes`;
  }
  return schedule.cronExpression ?? "Custom schedule";
}

// ── Rows that load their own data ─────────────────────────────────────────────
// Each suspends on its own, so the rest of the page renders immediately.

function NotificationsRow({ onError }: { onError: (message: string) => void }) {
  const { data: settings } = useSuspenseQuery(localConfigQueryOptions);
  const patch = useOptimisticMutation<LocalConfig, Partial<LocalConfig>>({
    queryKey: localConfigQueryOptions.queryKey,
    mutationFn: async (update) => {
      const result = await rpc.request.setLocalConfig(update);
      if (!result.ok) throw new Error(result.error ?? "Save failed.");
      return { ...settings, ...update };
    },
    apply: (current, update) => current && { ...current, ...update },
    onError: (error) => onError(error.message || "Save failed."),
  });
  return (
    <div className="settings__row">
      <div className="settings__row-content">
        <span className="settings__row-label">Enable notifications</span>
        <span className="settings__row-desc">
          Show desktop alerts for background activity
        </span>
      </div>
      <Toggle
        checked={settings.notificationsEnabled}
        onChange={(v) => patch.mutate({ notificationsEnabled: v })}
      />
    </div>
  );
}

function SynthesisRow({ onError }: { onError: (message: string) => void }) {
  const workspaceKey = useWorkspaceKey();
  const { data: schedule } = useSuspenseQuery(synthesisScheduleQueryOptions(workspaceKey));
  const toggle = useOptimisticMutation<SynthesisSchedule | null, boolean>({
    queryKey: queryKeys.synthesisSchedule(workspaceKey),
    mutationFn: async (enabled) => {
      const result = await rpc.request.setSynthesisEnabled({ enabled });
      if (!result.ok || !result.schedule) throw new Error(result.error ?? "Save failed.");
      return result.schedule;
    },
    apply: (current, enabled) => current && { ...current, enabled },
    onError: (error) => onError(error.message || "Save failed."),
  });
  if (!schedule) return null;
  return (
    <div className="settings__row">
      <div className="settings__row-content">
        <span className="settings__row-label">Synthesize workspace context</span>
        <span className="settings__row-desc">
          {describeSynthesisCadence(schedule)}
        </span>
      </div>
      <Toggle
        checked={schedule.enabled}
        disabled={toggle.isPending}
        onChange={(v) => toggle.mutate(v)}
      />
    </div>
  );
}

function RowSkeleton({ label }: { label: string }) {
  return (
    <div className="settings__row" aria-busy="true">
      <div className="settings__row-content">
        <span className="settings__row-label">{label}</span>
        <span className="settings__row-desc">Loading…</span>
      </div>
    </div>
  );
}

function VersionText() {
  const { data } = useSuspenseQuery(appVersionQueryOptions);
  return <>Draft {data.version}</>;
}

function ChannelText() {
  const { data } = useSuspenseQuery(appVersionQueryOptions);
  return <>{data.channel !== "dev" ? `${data.channel} channel` : ""}</>;
}

function BookCallButton() {
  const { data } = useSuspenseQuery(crispConfigQueryOptions);
  if (!data.cal_url) return null;
  return (
    <button
      className="feedback-row__btn"
      onClick={() => rpc.send.openUrl({ url: data.cal_url })}
    >
      Book a Call
    </button>
  );
}

// ── SettingsView ───────────────────────────────────────────────────────────────

interface SettingsViewProps {
  onOpenFeedback?: () => void;
}

export function SettingsView({ onOpenFeedback }: SettingsViewProps) {
  const [saveError, setSaveError]         = useState<string | null>(null);
  const [saveNotice, setSaveNotice]       = useState<string | null>(null);
  const [updateCheckState, setUpdateCheckState] = useState<"idle" | "checking" | "available" | "up-to-date" | "failed">("idle");
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);

  const { privacy, setConsent } = useAnalytics();
  const [theme, setTheme] = useState<ThemePreference>(() => {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      return isThemePreference(stored) ? stored : "system";
    } catch {
      return "system";
    }
  });
  const { cloudSignIn, cloudSignInError, handleCloudSignIn, handleCloudSignOut } = useCloudSignIn();

  // ── Update events ──────────────────────────────────────────────────────────
  useEffect(() => {
    const unsubs = [
      events.on("updateCheckStarted", () => setUpdateCheckState("checking")),
      events.on("updateAvailable", ({ version }) => {
        setPendingVersion(version);
        setUpdateCheckState("available");
      }),
      events.on("updateNotAvailable", () => {
        setUpdateCheckState("up-to-date");
        setTimeout(() => setUpdateCheckState("idle"), 3_000);
      }),
      events.on("updateCheckFailed", () => {
        setUpdateCheckState("failed");
        setTimeout(() => setUpdateCheckState("idle"), 5_000);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);


  // ── Save error auto-dismiss ────────────────────────────────────────────────
  useEffect(() => {
    if (!saveError) return;
    const id = setTimeout(() => setSaveError(null), 3_000);
    return () => clearTimeout(id);
  }, [saveError]);

  // ── Save notice auto-dismiss ───────────────────────────────────────────────
  useEffect(() => {
    if (!saveNotice) return;
    const id = setTimeout(() => setSaveNotice(null), 3_000);
    return () => clearTimeout(id);
  }, [saveNotice]);

  async function savePrivacy(save: () => Promise<void>) {
    try {
      await save();
    } catch {
      setSaveError("Could not save your privacy choice. Sign in and try again.");
    }
  }

  function changeTheme(next: ThemePreference) {
    setTheme(next);
    applyTheme(next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch {}
  }

  // ── Check for updates ──────────────────────────────────────────────────────
  function handleCheckForUpdates() {
    setUpdateCheckState("checking");
    rpc.send.requestUpdateCheck({});
  }

  // ── Derived update desc ────────────────────────────────────────────────────
  const updateDesc =
    updateCheckState === "checking"   ? "Checking for updates…"                          :
    updateCheckState === "available"  ? `Version ${pendingVersion ?? ""} is ready to install` :
    updateCheckState === "up-to-date" ? "You're up to date"                               :
    updateCheckState === "failed"     ? "Could not check for updates"                     :
    (
      <DataBoundary fallback={null} errorFallback={null}>
        <ChannelText />
      </DataBoundary>
    );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="settings">
      <SettingsHeader />

      <div className="settings__body">

        {/* ── System ─────────────────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">System</h2>
          <div className="settings__rows">
            <div className="settings__row">
              <div className="settings__row-content">
                <span className="settings__row-label">Draft Cloud</span>
                <span className="settings__row-desc">
                  {cloudSignIn === "awaiting_approval"
                    ? "Finish signing in in your browser"
                    : cloudSignIn === "complete"
                      ? "Signed in"
                      : cloudSignIn === "error"
                        ? `Sign-in failed${cloudSignInError ? `: ${cloudSignInError}` : ""}`
                        : "Connect this desktop app to your Draft account"}
                </span>
              </div>
              <button
                className="settings__action-button"
                disabled={
                  cloudSignIn === "awaiting_approval"
                }
                onClick={() => void (cloudSignIn === "complete" ? handleCloudSignOut() : handleCloudSignIn())}
              >
                {cloudSignIn === "awaiting_approval"
                  ? "Waiting…"
                  : cloudSignIn === "complete"
                    ? "Sign out"
                    : "Sign in"}
              </button>
            </div>
            <DataBoundary fallback={<RowSkeleton label="Enable notifications" />} errorFallback={null}>
              <NotificationsRow onError={setSaveError} />
            </DataBoundary>
            {/* Only shown when the schedule loads, as before. */}
            <DataBoundary fallback={<RowSkeleton label="Synthesize workspace context" />} errorFallback={null}>
              <SynthesisRow onError={setSaveError} />
            </DataBoundary>
          </div>
        </section>

        {/* ── Privacy ─────────────────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">Privacy</h2>
          <ul className="ui-rows">
            <PrivacyRows
              analyticsConsent={privacy?.analyticsConsent ?? false}
              onAnalyticsChange={(next) => void savePrivacy(() => setConsent(next))}
              onOpenUrl={(url) => rpc.send.openUrl({ url })}
            />
          </ul>
        </section>

        {/* ── Appearance ──────────────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">Appearance</h2>
          <ul className="ui-rows">
            <li><AppearanceRow value={theme} onChange={changeTheme} /></li>
          </ul>
        </section>

        {/* ── Updates ─────────────────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">Updates</h2>
          <div className="settings__rows">
            <div className="settings__row">
              <div className="settings__row-content">
                <span className="settings__row-label">
                  <DataBoundary fallback="Draft" errorFallback="Draft">
                    <VersionText />
                  </DataBoundary>
                </span>
                <span className="settings__row-desc">{updateDesc}</span>
              </div>
              {updateCheckState === "available" ? (
                <button
                  className="app-row__connect"
                  onClick={() => void rpc.request.applyUpdate()}
                >
                  Restart and update
                </button>
              ) : (
                <button
                  className="app-row__connect"
                  onClick={handleCheckForUpdates}
                  disabled={updateCheckState === "checking"}
                >
                  {updateCheckState === "checking" ? "Checking…" : "Check for updates"}
                </button>
              )}
            </div>
          </div>
        </section>

        {/* ── Feedback ────────────────────────────────────────────────────── */}
        {onOpenFeedback && (
          <section className="settings__section settings__section--feedback">
            <div className="feedback-row">
              <div className="feedback-row__text">
                <span className="feedback-row__label">Share Feedback</span>
                <span className="feedback-row__desc">Questions, bugs, or ideas — we read everything.</span>
              </div>
              <div className="feedback-row__actions">
                <DataBoundary fallback={null} errorFallback={null}>
                  <BookCallButton />
                </DataBoundary>
                <button className="feedback-row__btn feedback-row__btn--primary" onClick={onOpenFeedback}>
                  Open Chat
                </button>
              </div>
            </div>
          </section>
        )}

      </div>

      {saveError && (
        <div className="settings__save-error" role="alert">{saveError}</div>
      )}
      {saveNotice && (
        <div className="settings__save-notice" role="status">{saveNotice}</div>
      )}
    </div>
  );
}

// ── Shared header ──────────────────────────────────────────────────────────────

function SettingsHeader() {
  return (
    <div className="settings__header">
      <h1 className="ui-page__title">Settings</h1>
      <p className="ui-page__intro">Make Draft feel right for you.</p>
    </div>
  );
}

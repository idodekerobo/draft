// SettingsView.tsx — user-configurable settings + connected apps
//
// Sections (top → bottom):
//   Context             — Apply team context mode
//   Input Sources       — which integrations are connected; disconnect action
//   System              — Draft Cloud sign-in, Enable notifications
//   Privacy             — interaction recording opt-out
//   Updates             — current version, check for updates
//
// Connected apps data (getConnectedApps) and settings (getLocalConfig) are
// loaded in parallel on mount and on every profile switch.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AppVersionInfo, ConnectedAppsStatus, IntegrationDetail, LocalConfig } from "../../../rpc/schema";
import { events, rpc } from "../../rpc";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { FirefliesConnectPanel } from "../shared/FirefliesConnectPanel";
import { GithubConnectPanel } from "../shared/GithubConnectPanel";
import { LinearConnectPanel } from "../shared/LinearConnectPanel";
import { SessionTrackingPanel } from "../shared/SessionTrackingPanel";
import { SlackConnectPanel } from "../shared/SlackConnectPanel";
import { useCloudSignIn } from "../../hooks/useCloudSignIn";

// ── Helpers ────────────────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1)  return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24)   return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

// ── Sub-components: Controls ───────────────────────────────────────────────────

interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

function Toggle({ checked, onChange, disabled }: ToggleProps) {
  return (
    <button
      className={`toggle${checked ? " toggle--on" : ""}${disabled ? " toggle--disabled" : ""}`}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__thumb" />
    </button>
  );
}

interface SegmentControlProps {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

function SegmentControl({ value, options, onChange }: SegmentControlProps) {
  return (
    <div className="segment-control" role="group">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`segment-control__btn${value === opt.value ? " segment-control__btn--active" : ""}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Sub-components: Connected Apps ─────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  slack:     "Slack",
  fireflies: "Fireflies",
  linear:    "Linear",
  github:    "GitHub",
};

interface InputSourceRowProps {
  sourceKey: "slack" | "fireflies" | "linear" | "github";
  detail: IntegrationDetail;
  onDisconnect: () => void;
  onToggleConnect: () => void;
  isDisconnecting: boolean;
  isExpanded: boolean;
  /** Shown next to Disconnect when already connected — e.g. "Update channels" for Slack. */
  connectedAction?: { label: string; onClick: () => void };
  children?: ReactNode;
}

function InputSourceRow({
  sourceKey,
  detail,
  onDisconnect,
  onToggleConnect,
  isDisconnecting,
  isExpanded,
  connectedAction,
  children,
}: InputSourceRowProps) {
  const needsAttention = detail.connected && detail.healthStatus === "needs_attention";

  function buildMeta(): string {
    if (!detail.connected) return "Not connected";
    const parts: string[] = [];
    if (detail.mode)     parts.push(detail.mode);
    if (detail.channels) parts.push(`${detail.channels} channels`);
    const time = relativeTime(detail.lastConnected);
    if (time) parts.push(time);
    return parts.join(" · ");
  }

  return (
    <div className={`app-row app-row--source${isExpanded ? " app-row--expanded" : ""}`}>
      <div className="app-row__main">
        <div className="app-row__left">
          <span className={`app-row__status-dot${needsAttention ? " app-row__status-dot--attention" : detail.connected ? " app-row__status-dot--on" : ""}`} />
          <div className="app-row__text">
            <span className="app-row__name">{SOURCE_LABELS[sourceKey] ?? sourceKey}</span>
            <span className="app-row__meta">{buildMeta()}</span>
            {needsAttention && (
              <span className="app-row__warning">
                Needs attention — {detail.healthMessage ?? "Draft cannot currently reach this source."} Reconnect the integration if this persists.
              </span>
            )}
          </div>
        </div>

        <div className="app-row__right">
          {detail.connected ? (
            <>
              {connectedAction && (
                <button className="app-row__manage" onClick={connectedAction.onClick}>
                  {connectedAction.label}
                </button>
              )}
              <button
                className="app-row__disconnect"
                onClick={onDisconnect}
                disabled={isDisconnecting}
              >
                {isDisconnecting ? "Disconnecting…" : "Disconnect"}
              </button>
            </>
          ) : (
            <button
              className="app-row__connect"
              onClick={onToggleConnect}
            >
              {isExpanded ? "Close" : "Connect"}
            </button>
          )}
        </div>
      </div>

      {isExpanded && children}
    </div>
  );
}

// ── SettingsView ───────────────────────────────────────────────────────────────

interface SettingsViewProps {
  activeProfile: string;
  onOpenFeedback?: () => void;
}

export function SettingsView({ activeProfile, onOpenFeedback }: SettingsViewProps) {
  const [settings, setSettings]           = useState<LocalConfig | null>(null);
  const [apps, setApps]                   = useState<ConnectedAppsStatus | null>(null);
  const [loadError, setLoadError]         = useState<string | null>(null);
  const [saveError, setSaveError]         = useState<string | null>(null);
  const [saveNotice, setSaveNotice]       = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<"slack" | "fireflies" | "linear" | "github" | null>(null);
  const [expandedSource, setExpandedSource] = useState<"slack" | "fireflies" | "linear" | "github" | null>(null);
  const [slackPanelMode, setSlackPanelMode] = useState<"connect" | "manage">("connect");
  const [versionInfo, setVersionInfo]     = useState<AppVersionInfo | null>(null);
  const [updateCheckState, setUpdateCheckState] = useState<"idle" | "checking" | "available" | "up-to-date" | "failed">("idle");
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  const [calUrl, setCalUrl]                = useState<string>("");

  const { config: analyticsConfig, setReplayEnabled, track } = useAnalytics();
  const { cloudSignIn, cloudSignInError, handleCloudSignIn, handleCloudSignOut } = useCloudSignIn();

  // ── Load ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    setSettings(null);
    setApps(null);
    setLoadError(null);

    Promise.all([
      rpc.request.getLocalConfig(),
      rpc.request.getConnectedApps(),
      rpc.request.getAppVersion(),
      rpc.request.getCrispConfig(),
    ])
      .then(([config, connectedApps, appVersion, crispConfig]) => {
        setSettings(config);
        setApps(connectedApps);
        setVersionInfo(appVersion);
        setCalUrl(crispConfig.cal_url);
      })
      .catch(() => setLoadError("Failed to load settings."));
  }, [activeProfile]);

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

  // ── Settings patch ─────────────────────────────────────────────────────────
  async function patch(update: Partial<LocalConfig>) {
    if (!settings) return;
    const next = { ...settings, ...update };
    setSettings(next);
    try {
      const result = await rpc.request.setLocalConfig(update);
      if (!result.ok) setSaveError(result.error ?? "Save failed.");
    } catch {
      setSaveError("Save failed.");
      setSettings(settings);
    }
  }

  // ── Disconnect ─────────────────────────────────────────────────────────────
  async function handleDisconnect(source: "slack" | "fireflies" | "linear" | "github") {
    if (!apps) return;
    setDisconnecting(source);
    try {
      const result = await rpc.request.disconnectIntegration({ source });
      if (result.ok) {
        if (source === "slack") {
          setSlackPanelMode("connect");
          setExpandedSource((current) => current === "slack" ? null : current);
        }
        setApps({
          ...apps,
          integrations: {
            ...apps.integrations,
            [source]: { ...apps.integrations[source], connected: false },
          },
        });
      } else {
        setSaveError(result.error ?? "Disconnect failed.");
      }
    } catch {
      setSaveError("Disconnect failed.");
    } finally {
      setDisconnecting(null);
    }
  }

  async function refreshConnectedApps() {
    try {
      const updated = await rpc.request.getConnectedApps();
      setApps(updated);
    } catch { /* non-fatal */ }
  }

  function toggleSlackPanel(mode: "connect" | "manage") {
    setSaveError(null);
    setExpandedSource((current) => {
      const alreadyOpenSameMode = current === "slack" && slackPanelMode === mode;
      if (alreadyOpenSameMode) {
        return null;
      }
      setSlackPanelMode(mode);
      return "slack";
    });
  }

  // ── Check for updates ──────────────────────────────────────────────────────
  function handleCheckForUpdates() {
    setUpdateCheckState("checking");
    rpc.send.requestUpdateCheck({});
  }

  // ── Loading / error states ─────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="settings">
        <SettingsHeader />
        <div className="settings__load-error">{loadError}</div>
      </div>
    );
  }

  if (!settings || !apps) {
    return (
      <div className="settings">
        <SettingsHeader />
        <div className="settings__loading">Loading…</div>
      </div>
    );
  }

  // ── Derived update desc ────────────────────────────────────────────────────
  const updateDesc =
    updateCheckState === "checking"   ? "Checking for updates…"                          :
    updateCheckState === "available"  ? `Version ${pendingVersion ?? ""} is ready to install` :
    updateCheckState === "up-to-date" ? "You're up to date"                               :
    updateCheckState === "failed"     ? "Could not check for updates"                     :
    versionInfo && versionInfo.channel !== "dev" ? `${versionInfo.channel} channel`       : "";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="settings">
      <SettingsHeader />

      <div className="settings__body">

        {/* ── Input Sources ──────────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">Input Sources</h2>
          <div className="settings__rows">
            {(["fireflies", "linear", "slack", "github"] as const).map((key) => (
              <InputSourceRow
                key={key}
                sourceKey={key}
                detail={apps.integrations[key]}
                onDisconnect={() => void handleDisconnect(key)}
                onToggleConnect={() => {
                  if (key === "slack") {
                    toggleSlackPanel("connect");
                  } else {
                    setExpandedSource((current) => current === key ? null : key);
                  }
                }}
                isDisconnecting={disconnecting === key}
                isExpanded={expandedSource === key}
                connectedAction={key === "slack" ? { label: "Update channels", onClick: () => toggleSlackPanel("manage") } : undefined}
              >
                {key === "fireflies" && (
                  <FirefliesConnectPanel detail={apps.integrations.fireflies} classPrefix="app-row" onConnected={async () => { await refreshConnectedApps(); setExpandedSource(null); }} />
                )}

                {key === "linear" && (
                  <LinearConnectPanel detail={apps.integrations.linear} classPrefix="app-row" onConnected={async () => { await refreshConnectedApps(); setExpandedSource(null); }} />
                )}

                {key === "slack" && (
                  <SlackConnectPanel detail={apps.integrations.slack} mode={slackPanelMode} classPrefix="app-row" onConnected={async () => { await refreshConnectedApps(); setExpandedSource(null); }} />
                )}

                {key === "github" && (
                  <GithubConnectPanel detail={apps.integrations.github} classPrefix="app-row" onConnected={async () => { await refreshConnectedApps(); setExpandedSource(null); }} />
                )}
              </InputSourceRow>
            ))}
          </div>
        </section>

        {/* ── Coding Sessions ────────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">Coding Sessions</h2>
          <div className="settings__rows">
            <SessionTrackingPanel detail={apps.integrations.claudeSession} onChanged={refreshConnectedApps} variant="settings" />
          </div>
        </section>

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
            <div className="settings__row">
              <div className="settings__row-content">
                <span className="settings__row-label">Enable notifications</span>
                <span className="settings__row-desc">
                  Show desktop alerts for background activity
                </span>
              </div>
              <Toggle
                checked={settings.notificationsEnabled}
                onChange={(v) => void patch({ notificationsEnabled: v })}
              />
            </div>
          </div>
        </section>

        {/* ── Privacy ─────────────────────────────────────────────────────── */}
        {analyticsConfig?.consent === "opted_in" && (
          <section className="settings__section">
            <h2 className="settings__section-label">Privacy</h2>
            <div className="settings__rows">
              <div className="settings__row">
                <div className="settings__row-content">
                  <span className="settings__row-label">Share interaction recordings</span>
                  <span className="settings__row-desc">
                    Masked — no text or file content is ever captured. Helps us improve
                    navigation and layout.
                  </span>
                </div>
                <Toggle
                  checked={analyticsConfig.replay_enabled}
                  onChange={(v) => {
                    if (v) track("analytics_consent_granted", {});
                    void setReplayEnabled(v);
                  }}
                />
              </div>
            </div>
          </section>
        )}

        {/* ── Updates ─────────────────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">Updates</h2>
          <div className="settings__rows">
            <div className="settings__row">
              <div className="settings__row-content">
                <span className="settings__row-label">
                  {versionInfo ? `Draft ${versionInfo.version}` : "Draft"}
                </span>
                <span className="settings__row-desc">{updateDesc}</span>
              </div>
              {updateCheckState === "available" ? (
                <button
                  className="app-row__connect"
                  onClick={() => void rpc.request.applyUpdate()}
                >
                  Restart & Update
                </button>
              ) : (
                <button
                  className="app-row__connect"
                  onClick={handleCheckForUpdates}
                  disabled={updateCheckState === "checking"}
                >
                  {updateCheckState === "checking" ? "Checking…" : "Check for Updates"}
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
                {calUrl && (
                  <button
                    className="feedback-row__btn"
                    onClick={() => rpc.send.openUrl({ url: calUrl })}
                  >
                    Book a Call
                  </button>
                )}
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
      <span className="settings__title">Settings</span>
    </div>
  );
}

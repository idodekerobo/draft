// SettingsView.tsx — user-configurable settings + connected apps
//
// Sections (top → bottom):
//   Context             — Apply team context mode
//   Intelligence Tools  — which coding tools have Draft installed (view-only)
//   Input Sources       — which integrations are connected; disconnect action
//   System              — Start on login, Enable notifications
//   Privacy             — interaction recording opt-out
//   Updates             — current version, check for updates
//
// Connected apps data (getConnectedApps) and settings (getLocalConfig) are
// loaded in parallel on mount and on every profile switch.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AppVersionInfo, ConnectedAppsStatus, InstallableTool, IntegrationDetail, LocalConfig, ToolDetail } from "../../../rpc/schema";
import { events, rpc } from "../../rpc";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { FirefliesConnectPanel } from "../shared/FirefliesConnectPanel";
import { GranolaConnectPanel } from "../shared/GranolaConnectPanel";
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

function shortDate(iso: string | null): string {
  if (!iso || iso === "migrated") return iso ?? "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ── Session synthesis helpers ──────────────────────────────────────────────────

function codexIntervalToDisplay(minutes: number): { value: string; unit: "hours" | "minutes" } {
  if (minutes % 60 === 0) return { value: String(minutes / 60), unit: "hours" };
  return { value: String(minutes), unit: "minutes" };
}

function codexDisplayToMinutes(value: string, unit: "hours" | "minutes"): number {
  const n = Math.max(1, parseInt(value, 10) || 1);
  return unit === "hours" ? n * 60 : n;
}

// ── Sub-components: Controls ───────────────────────────────────────────────────

interface IntervalUnitDropdownProps {
  value: "hours" | "minutes";
  onChange: (value: "hours" | "minutes") => void;
}

function IntervalUnitDropdown({ value, onChange }: IntervalUnitDropdownProps) {
  const [open, setOpen] = useState(false);

  const options: Array<"minutes" | "hours"> = ["minutes", "hours"];

  return (
    <div
      className="settings__interval-unit-wrapper"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setOpen(false);
        }
      }}
    >
      <button
        className="settings__interval-unit-btn"
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{value}</span>
        <svg
          className={`settings__interval-unit-chevron${open ? " settings__interval-unit-chevron--open" : ""}`}
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill="none"
          aria-hidden="true"
        >
          <path d="M1 2.5L4 5.5L7 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="settings__interval-unit-list" role="listbox">
          {options.map((opt) => (
            <li
              key={opt}
              role="option"
              aria-selected={opt === value}
              className={`settings__interval-unit-option${opt === value ? " settings__interval-unit-option--selected" : ""}`}
              onMouseDown={(e) => {
                // mousedown fires before blur; prevent blur from closing before click registers
                e.preventDefault();
              }}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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

const TOOL_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex:         "Codex",
  cursor:        "Cursor",
  openclaw:      "OpenClaw",
  hermes:        "Hermes",
};

const TOOL_COMMANDS: Record<string, string> = {
  "claude-code": "draft add claude-code",
  codex:         "draft add codex",
  cursor:        "draft add cursor",
  openclaw:      "draft add openclaw",
  hermes:        "draft add hermes",
};

interface IntelligenceToolRowProps {
  toolKey: string;
  detail: ToolDetail;
  onInstalled: () => void;
}

function IntelligenceToolRow({ toolKey, detail, onInstalled }: IntelligenceToolRowProps) {
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  async function handleAdd() {
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await rpc.request.runInstall({ tools: [toolKey as InstallableTool] });
      if (result.ok) {
        onInstalled();
      } else {
        const failed = result.steps.find((s) => !s.ok);
        setInstallError(failed?.error ?? "Install failed.");
      }
    } catch {
      setInstallError(`Install failed. Run: ${TOOL_COMMANDS[toolKey] ?? `draft add ${toolKey}`}`);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="app-row">
      <div className="app-row__left">
        <span className={`app-row__status-dot${detail.installed ? " app-row__status-dot--on" : ""}`} />
        <div className="app-row__text">
          <span className="app-row__name">{TOOL_LABELS[toolKey] ?? toolKey}</span>
          {detail.installed ? (
            <span className="app-row__meta">
              Installed
              {detail.addedAt && detail.addedAt !== "migrated" && (
                <> · {shortDate(detail.addedAt)}</>
              )}
            </span>
          ) : (
            <span className="app-row__meta">Not set up</span>
          )}
          {installError && <span className="app-row__hint">{installError}</span>}
        </div>
      </div>

      {!detail.installed && (
        <button
          className="app-row__connect"
          onClick={() => void handleAdd()}
          disabled={installing}
        >
          {installing ? "Adding…" : "Add"}
        </button>
      )}
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  granola:   "Granola",
  slack:     "Slack",
  github:    "GitHub",
  fireflies: "Fireflies",
};

interface InputSourceRowProps {
  sourceKey: "granola" | "slack" | "github" | "fireflies";
  detail: IntegrationDetail;
  onDisconnect: () => void;
  onToggleConnect: () => void;
  onConnectGitHub: () => void;
  isDisconnecting: boolean;
  isExpanded: boolean;
  isConnectingGitHub: boolean;
  /** Shown next to Disconnect when already connected — e.g. "Update channels" for Slack. */
  connectedAction?: { label: string; onClick: () => void };
  children?: ReactNode;
}

function InputSourceRow({
  sourceKey,
  detail,
  onDisconnect,
  onToggleConnect,
  onConnectGitHub,
  isDisconnecting,
  isExpanded,
  isConnectingGitHub,
  connectedAction,
  children,
}: InputSourceRowProps) {
  const isGitHub = sourceKey === "github";
  const isPending = isGitHub && isConnectingGitHub;
  const needsAttention = detail.connected && detail.healthStatus === "needs_attention";

  function buildMeta(): string {
    if (!detail.connected) return "Not connected";
    const parts: string[] = [];
    if (detail.mode)     parts.push(detail.mode);
    if (detail.channels) parts.push(`${detail.channels} channels`);
    if (detail.repos.length > 0) {
      parts.push(detail.repos.length === 1 ? detail.repos[0]! : `${detail.repos.length} repos`);
    }
    const time = relativeTime(detail.lastConnected);
    if (time) parts.push(time);
    return parts.join(" · ");
  }

  return (
    <div className={`app-row app-row--source${isExpanded ? " app-row--expanded" : ""}`}>
      <div className="app-row__main">
        <div className="app-row__left">
          <span className={`app-row__status-dot${needsAttention ? " app-row__status-dot--attention" : detail.connected ? " app-row__status-dot--on" : isPending ? " app-row__status-dot--pending" : ""}`} />
          <div className="app-row__text">
            <span className="app-row__name">{SOURCE_LABELS[sourceKey] ?? sourceKey}</span>
            <span className="app-row__meta">
              {isPending ? "Complete sign-in in your browser…" : buildMeta()}
            </span>
            {isGitHub && detail.connected && (
              <>
                <span className="app-row__hint">
                  Tracks merged PRs, releases, and open PRs · polls hourly
                </span>
                {detail.ghCliStatus === "not_found" && (
                  <span className="app-row__warning">
                    gh CLI not installed — GitHub sync is paused.{" "}
                    <button
                      className="app-row__link-btn"
                      onClick={() => rpc.send.openUrl({ url: "https://cli.github.com/" })}
                    >
                      Install at cli.github.com
                    </button>
                    {" "}and GitHub sync will resume automatically.
                  </span>
                )}
                {detail.ghCliStatus === "not_authenticated" && (
                  <span className="app-row__warning">
                    gh CLI not authenticated — run{" "}
                    <code className="app-row__code">gh auth login</code>
                    {" "}in your terminal. GitHub sync will resume automatically.
                  </span>
                )}
              </>
            )}
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
          ) : isGitHub ? (
            <button
              className="app-row__connect"
              onClick={onConnectGitHub}
              disabled={isPending}
            >
              {isPending ? "Waiting…" : "Connect"}
            </button>
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
  const [disconnecting, setDisconnecting] = useState<"granola" | "slack" | "github" | "fireflies" | null>(null);
  const [connectingGitHub, setConnectingGitHub] = useState(false);
  const [expandedSource, setExpandedSource] = useState<"granola" | "slack" | "fireflies" | null>(null);
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
  async function handleDisconnect(source: "granola" | "slack" | "github" | "fireflies") {
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

  // ── Tool install (from Settings) ───────────────────────────────────────────
  async function handleToolInstalled() {
    await refreshConnectedApps();
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

  // ── GitHub connect ─────────────────────────────────────────────────────────
  // Fire-and-forget: opens browser OAuth, then polls getConnectedApps every 2s
  // until github.connected flips to true.
  async function handleConnectGitHub() {
    setConnectingGitHub(true);
    setSaveError(null);
    try {
      const result = await rpc.request.connectGitHub();
      if (!result.ok) {
        setSaveError(result.error ?? "GitHub connect failed.");
        setConnectingGitHub(false);
      }
      // On ok:true, background process is running. Polling effect takes over.
    } catch {
      setSaveError("GitHub connect failed.");
      setConnectingGitHub(false);
    }
  }

  // Poll getConnectedApps while GitHub OAuth is in progress.
  useEffect(() => {
    if (!connectingGitHub) return;
    const id = setInterval(async () => {
      try {
        const updated = await rpc.request.getConnectedApps();
        if (updated.integrations.github.connected) {
          setApps(updated);
          setConnectingGitHub(false);
        }
      } catch { /* keep polling */ }
    }, 2_000);
    // Safety timeout — stop polling after 5 minutes.
    const timeout = setTimeout(() => {
      setConnectingGitHub(false);
      setSaveError("GitHub sign-in timed out. Try again.");
    }, 5 * 60 * 1_000);
    return () => { clearInterval(id); clearTimeout(timeout); };
  }, [connectingGitHub]);

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

        {/* ── Intelligence Tools ─────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">Intelligence Tools</h2>
          <div className="settings__rows">
            {(["claude-code", "codex", "openclaw", "hermes"] as const).map((key) => (
              <IntelligenceToolRow key={key} toolKey={key} detail={apps.tools[key]} onInstalled={handleToolInstalled} />
            ))}
          </div>
        </section>

        {/* ── Input Sources ──────────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">Input Sources</h2>
          <div className="settings__rows">
            {/* Claude Code sessions */}
            <div className="settings__row">
              <div className="settings__row-content">
                <span className="settings__row-label">Claude Code sessions</span>
                <span className="settings__row-desc">Synthesize context from Claude Code sessions</span>
              </div>
              <Toggle
                checked={settings.claudeCodeSynthesis}
                onChange={(v) => void patch({ claudeCodeSynthesis: v })}
              />
            </div>

            {/* Codex sessions */}
            {(() => {
              const { value: codexVal, unit: codexUnit } =
                codexIntervalToDisplay(settings.codexScanIntervalMinutes ?? 360);
              return (
                <div className="settings__row">
                  <div className="settings__row-content">
                    <span className="settings__row-label">Codex sessions</span>
                    <span className="settings__row-desc">
                      {settings.codexScanIntervalMinutes !== null
                        ? `Scans every ${codexVal} ${codexUnit}`
                        : "Synthesis disabled"}
                    </span>
                  </div>
                  <div className="settings__row-control-stack">
                    {settings.codexScanIntervalMinutes !== null && (
                      <>
                        <input
                          className="settings__interval-input"
                          type="number"
                          min="1"
                          value={codexVal}
                          onChange={(e) => void patch({
                            codexScanIntervalMinutes: codexDisplayToMinutes(e.target.value, codexUnit),
                          })}
                        />
                        <IntervalUnitDropdown
                          value={codexUnit}
                          onChange={(newUnit) => {
                            void patch({
                              codexScanIntervalMinutes: codexDisplayToMinutes(codexVal, newUnit),
                            });
                          }}
                        />
                      </>
                    )}
                    <Toggle
                      checked={settings.codexScanIntervalMinutes !== null}
                      onChange={(v) => void patch({ codexScanIntervalMinutes: v ? 360 : null })}
                    />
                  </div>
                </div>
              );
            })()}

            {(["granola", "fireflies", "slack", "github"] as const).map((key) => (
              <InputSourceRow
                key={key}
                sourceKey={key}
                detail={apps.integrations[key]}
                onDisconnect={() => void handleDisconnect(key)}
                onToggleConnect={() => {
                  if (key === "slack") {
                    toggleSlackPanel("connect");
                  } else if (key !== "github") {
                    setExpandedSource((current) => current === key ? null : key);
                  }
                }}
                onConnectGitHub={() => void handleConnectGitHub()}
                isDisconnecting={disconnecting === key}
                isExpanded={expandedSource === key}
                isConnectingGitHub={connectingGitHub}
                connectedAction={key === "slack" ? { label: "Update channels", onClick: () => toggleSlackPanel("manage") } : undefined}
              >
                {key === "granola" && (
                  <GranolaConnectPanel detail={apps.integrations.granola} classPrefix="app-row" onConnected={async () => { await refreshConnectedApps(); setExpandedSource(null); }} />
                )}

                {key === "fireflies" && (
                  <FirefliesConnectPanel detail={apps.integrations.fireflies} classPrefix="app-row" onConnected={async () => { await refreshConnectedApps(); setExpandedSource(null); }} />
                )}

                {key === "slack" && (
                  <SlackConnectPanel detail={apps.integrations.slack} mode={slackPanelMode} classPrefix="app-row" onConnected={async () => { await refreshConnectedApps(); setExpandedSource(null); }} />
                )}
              </InputSourceRow>
            ))}
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
                <span className="settings__row-label">Start on login</span>
                <span className="settings__row-desc">
                  Launch Draft automatically when you log in to your Mac
                </span>
              </div>
              <Toggle
                checked={settings.launchOnLogin}
                onChange={(v) => void patch({ launchOnLogin: v })}
              />
            </div>
            <div className="settings__row">
              <div className="settings__row-content">
                <span className="settings__row-label">Enable notifications</span>
                <span className="settings__row-desc">
                  Show alerts when new proposals arrive or the daemon stops
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

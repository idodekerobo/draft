// SettingsView.tsx — user-configurable settings + connected apps
//
// Sections (top → bottom):
//   Context             — Apply team context mode
//   Session Context     — per-section injection toggles (conditional)
//   Intelligence Tools  — which coding tools have Draft installed (view-only)
//   Input Sources       — which integrations are connected; disconnect action
//   System              — Start on login, Enable notifications
//   Privacy             — interaction recording opt-out
//   Updates             — current version, check for updates
//
// Connected apps data (getConnectedApps) and settings (getLocalConfig) are
// loaded in parallel on mount and on every profile switch.

import { useEffect, useState } from "react";
import type { AppVersionInfo, ConnectedAppsStatus, ContextSection, InstallableTool, IntegrationDetail, LocalConfig, ToolDetail } from "../../../rpc/schema";
import { events, rpc } from "../../rpc";
import { useAnalytics } from "../../analytics/AnalyticsContext";

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
  granola: "Granola",
  slack:   "Slack",
  github:  "GitHub",
};

// Hint shown below the meta line when a source is not connected.
const SOURCE_CONNECT_HINT: Record<string, string> = {
  granola: "Run /draft-connect granola in Claude Code or Codex",
  slack:   "Run /draft-connect slack in Claude Code or Codex",
  github:  "",
};

interface InputSourceRowProps {
  sourceKey: "granola" | "slack" | "github";
  detail: IntegrationDetail;
  onDisconnect: () => void;
  onConnectGitHub: () => void;
  isDisconnecting: boolean;
  isConnectingGitHub: boolean;
}

function InputSourceRow({
  sourceKey,
  detail,
  onDisconnect,
  onConnectGitHub,
  isDisconnecting,
  isConnectingGitHub,
}: InputSourceRowProps) {
  const isGitHub = sourceKey === "github";
  const isPending = isGitHub && isConnectingGitHub;

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
    <div className="app-row">
      <div className="app-row__left">
        <span className={`app-row__status-dot${detail.connected ? " app-row__status-dot--on" : isPending ? " app-row__status-dot--pending" : ""}`} />
        <div className="app-row__text">
          <span className="app-row__name">{SOURCE_LABELS[sourceKey] ?? sourceKey}</span>
          <span className="app-row__meta">
            {isPending ? "Complete sign-in in your browser…" : buildMeta()}
          </span>
          {!detail.connected && !isPending && (
            <span className="app-row__hint">{SOURCE_CONNECT_HINT[sourceKey]}</span>
          )}
        </div>
      </div>

      <div className="app-row__right">
        {detail.connected ? (
          <>
            <button
              className="app-row__disconnect"
              onClick={onDisconnect}
              disabled={isDisconnecting}
            >
              {isDisconnecting ? "Disconnecting…" : "Disconnect"}
            </button>
            <span className="app-row__disconnect-note">Takes effect on next daemon cycle</span>
          </>
        ) : isGitHub ? (
          <button
            className="app-row__connect"
            onClick={onConnectGitHub}
            disabled={isPending}
          >
            {isPending ? "Waiting…" : "Connect"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── SettingsView ───────────────────────────────────────────────────────────────

interface SettingsViewProps {
  activeProfile: string;
}

export function SettingsView({ activeProfile }: SettingsViewProps) {
  const [settings, setSettings]           = useState<LocalConfig | null>(null);
  const [apps, setApps]                   = useState<ConnectedAppsStatus | null>(null);
  const [sections, setSections]           = useState<ContextSection[]>([]);
  const [loadError, setLoadError]         = useState<string | null>(null);
  const [saveError, setSaveError]         = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<"granola" | "slack" | "github" | null>(null);
  const [connectingGitHub, setConnectingGitHub] = useState(false);
  const [versionInfo, setVersionInfo]     = useState<AppVersionInfo | null>(null);
  const [updateCheckState, setUpdateCheckState] = useState<"idle" | "checking" | "available" | "up-to-date" | "failed">("idle");
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);

  const { config: analyticsConfig, setReplayEnabled, track } = useAnalytics();

  // ── Load ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    setSettings(null);
    setApps(null);
    setLoadError(null);

    Promise.all([
      rpc.request.getLocalConfig(),
      rpc.request.getConnectedApps(),
      rpc.request.getContextSections(),
      rpc.request.getAppVersion(),
    ])
      .then(([config, connectedApps, contextSections, appVersion]) => {
        setSettings(config);
        setApps(connectedApps);
        setSections(contextSections);
        setVersionInfo(appVersion);
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

  // ── Session context section toggle ─────────────────────────────────────────
  async function toggleSection(sectionName: string) {
    if (!settings) return;
    const current = settings.disabledContextSections;
    const next = current.includes(sectionName)
      ? current.filter((s) => s !== sectionName)
      : [...current, sectionName];
    await patch({ disabledContextSections: next });
  }

  // ── Disconnect ─────────────────────────────────────────────────────────────
  async function handleDisconnect(source: "granola" | "slack" | "github") {
    if (!apps) return;
    setDisconnecting(source);
    try {
      const result = await rpc.request.disconnectIntegration({ source });
      if (result.ok) {
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
    try {
      const updated = await rpc.request.getConnectedApps();
      setApps(updated);
    } catch { /* non-fatal */ }
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

        {/* ── Context ────────────────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">Context</h2>
          <div className="settings__rows">
            <div className="settings__row settings__row--stacked">
              <div className="settings__row-content">
                <span className="settings__row-label">Apply team context</span>
                <span className="settings__row-desc">
                  How updates from your team's shared context are applied at session start
                </span>
              </div>
              <SegmentControl
                value={settings.teamLoadMode}
                options={[
                  { value: "auto",   label: "Automatically" },
                  { value: "review", label: "Review first"  },
                ]}
                onChange={(v) => void patch({ teamLoadMode: v as "auto" | "review" })}
              />
            </div>
          </div>
        </section>

        {/* ── Session Context ─────────────────────────────────────────────── */}
        {sections.length > 0 && (
          <section className="settings__section">
            <h2 className="settings__section-label">Session Context</h2>
            <div className="settings__rows">
              {sections.map((sec) => {
                const enabled = !settings.disabledContextSections.includes(sec.name);
                const modeLabel = sec.injectionMode === "full" ? "full content" : "frontmatter only";
                return (
                  <div key={sec.name} className="settings__row">
                    <div className="settings__row-content">
                      <span className="settings__row-label">{sec.label}</span>
                      <span className="settings__row-desc">
                        Inject {modeLabel} into session start prompt
                      </span>
                    </div>
                    <Toggle
                      checked={enabled}
                      onChange={() => void toggleSection(sec.name)}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        )}

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
            {(["granola", "slack", "github"] as const).map((key) => (
              <InputSourceRow
                key={key}
                sourceKey={key}
                detail={apps.integrations[key]}
                onDisconnect={() => void handleDisconnect(key)}
                onConnectGitHub={() => void handleConnectGitHub()}
                isDisconnecting={disconnecting === key}
                isConnectingGitHub={connectingGitHub}
              />
            ))}
          </div>
        </section>

        {/* ── System ─────────────────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">System</h2>
          <div className="settings__rows">
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

      </div>

      {saveError && (
        <div className="settings__save-error" role="alert">{saveError}</div>
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

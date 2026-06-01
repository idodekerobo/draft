// SettingsView.tsx — user-configurable settings + connected apps
//
// Sections (top → bottom):
//   Intelligence Tools  — which coding tools have Draft installed (view-only)
//   Input Sources       — which integrations are connected; disconnect action
//   System              — Start on login
//   Context             — Apply team context mode
//   Notifications       — Enable notifications
//
// Connected apps data (getConnectedApps) and settings (getLocalConfig) are
// loaded in parallel on mount and on every profile switch.

import { useEffect, useState } from "react";
import type { ConnectedAppsStatus, IntegrationDetail, LocalConfig, ToolDetail } from "../../../rpc/schema";
import { rpc } from "../../rpc";

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
};

const TOOL_COMMANDS: Record<string, string> = {
  "claude-code": "draft add claude-code",
  codex:         "draft add codex",
  cursor:        "draft add cursor",
};

interface IntelligenceToolRowProps {
  toolKey: string;
  detail: ToolDetail;
}

function IntelligenceToolRow({ toolKey, detail }: IntelligenceToolRowProps) {
  const [copied, setCopied] = useState(false);
  const cmd = TOOL_COMMANDS[toolKey] ?? `draft add ${toolKey}`;

  function handleCopy() {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
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
        </div>
      </div>

      {!detail.installed && (
        <button className="app-row__cmd" onClick={handleCopy} title="Copy to clipboard">
          <span className="app-row__cmd-text">{cmd}</span>
          <span className="app-row__cmd-copy">{copied ? "Copied" : "Copy"}</span>
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

interface InputSourceRowProps {
  sourceKey: "granola" | "slack" | "github";
  detail: IntegrationDetail;
  onDisconnect: () => void;
  isDisconnecting: boolean;
}

function InputSourceRow({ sourceKey, detail, onDisconnect, isDisconnecting }: InputSourceRowProps) {
  function buildMeta(): string {
    if (!detail.connected) return "Not connected";
    const parts: string[] = [];
    if (detail.mode)     parts.push(detail.mode);
    if (detail.channels) parts.push(`${detail.channels} channels`);
    if (detail.repos.length > 0) {
      parts.push(detail.repos.length === 1 ? detail.repos[0] : `${detail.repos.length} repos`);
    }
    const time = relativeTime(detail.lastConnected);
    if (time) parts.push(time);
    return parts.join(" · ");
  }

  return (
    <div className="app-row">
      <div className="app-row__left">
        <span className={`app-row__status-dot${detail.connected ? " app-row__status-dot--on" : ""}`} />
        <div className="app-row__text">
          <span className="app-row__name">{SOURCE_LABELS[sourceKey] ?? sourceKey}</span>
          <span className="app-row__meta">{buildMeta()}</span>
          {!detail.connected && (
            <span className="app-row__hint">Connect with /draft:connect in Claude Code</span>
          )}
        </div>
      </div>

      {detail.connected && (
        <div className="app-row__right">
          <button
            className="app-row__disconnect"
            onClick={onDisconnect}
            disabled={isDisconnecting}
          >
            {isDisconnecting ? "Disconnecting…" : "Disconnect"}
          </button>
          <span className="app-row__disconnect-note">Takes effect on next daemon cycle</span>
        </div>
      )}
    </div>
  );
}

// ── SettingsView ───────────────────────────────────────────────────────────────

interface SettingsViewProps {
  activeProfile: string;
}

export function SettingsView({ activeProfile }: SettingsViewProps) {
  const [settings, setSettings]     = useState<LocalConfig | null>(null);
  const [apps, setApps]             = useState<ConnectedAppsStatus | null>(null);
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [saveError, setSaveError]   = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<"granola" | "slack" | "github" | null>(null);

  // ── Load ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    setSettings(null);
    setApps(null);
    setLoadError(null);

    Promise.all([
      rpc.request.getLocalConfig(),
      rpc.request.getConnectedApps(),
    ])
      .then(([config, connectedApps]) => {
        setSettings(config);
        setApps(connectedApps);
      })
      .catch(() => setLoadError("Failed to load settings."));
  }, [activeProfile]);

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

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="settings">
      <SettingsHeader />

      <div className="settings__body">

        {/* ── Intelligence Tools ─────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">Intelligence Tools</h2>
          <div className="settings__rows">
            {(["claude-code", "codex", "cursor"] as const).map((key) => (
              <IntelligenceToolRow key={key} toolKey={key} detail={apps.tools[key]} />
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
                isDisconnecting={disconnecting === key}
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
          </div>
        </section>

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

        {/* ── Notifications ──────────────────────────────────────────────── */}
        <section className="settings__section">
          <h2 className="settings__section-label">Notifications</h2>
          <div className="settings__rows">
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

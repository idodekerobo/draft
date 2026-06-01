// SettingsView.tsx — user-configurable settings
//
// Three sections:
//   System      — Start on login (launchOnLogin)
//   Context     — Apply team context mode (teamLoadMode)
//   Notifications — Enable notifications (notificationsEnabled)
//
// Settings load from per-profile local.json on mount and on profile switch.
// Each control saves immediately via setLocalConfig (optimistic update).

import { useEffect, useState } from "react";
import type { LocalConfig } from "../../../rpc/schema";
import { rpc } from "../../rpc";

// ── Sub-components ─────────────────────────────────────────────────────────────

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

// ── SettingsView ───────────────────────────────────────────────────────────────

interface SettingsViewProps {
  activeProfile: string;
}

export function SettingsView({ activeProfile }: SettingsViewProps) {
  const [settings, setSettings] = useState<LocalConfig | null>(null);
  const [loadError, setLoadError]   = useState<string | null>(null);
  const [saveError, setSaveError]   = useState<string | null>(null);

  // ── Load ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    setSettings(null);
    setLoadError(null);

    rpc.request.getLocalConfig()
      .then((config) => setSettings(config))
      .catch(() => setLoadError("Failed to load settings."));
  }, [activeProfile]);

  // ── Save error auto-dismiss ────────────────────────────────────────────────
  useEffect(() => {
    if (!saveError) return;
    const id = setTimeout(() => setSaveError(null), 3_000);
    return () => clearTimeout(id);
  }, [saveError]);

  // ── Patch ──────────────────────────────────────────────────────────────────
  // Optimistic: update local state immediately, then persist.
  async function patch(update: Partial<LocalConfig>) {
    if (!settings) return;
    const next = { ...settings, ...update };
    setSettings(next);
    try {
      const result = await rpc.request.setLocalConfig(update);
      if (!result.ok) setSaveError(result.error ?? "Save failed.");
    } catch {
      setSaveError("Save failed.");
      // Roll back on error
      setSettings(settings);
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

  if (!settings) {
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

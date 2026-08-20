import { useState } from "react";
import type { IntegrationDetail } from "../../../rpc/schema";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { rpc } from "../../rpc";

interface SessionTrackingPanelProps {
  detail: IntegrationDetail | undefined;
  onChanged: () => void | Promise<void>;
  variant: "settings" | "onboarding";
}

const DESCRIPTION = "Capture Claude Code sessions from repos with session capture enabled, so Draft can summarize and search them. Turning this off stops new sessions from any repo from being accepted, even if a repo already has session capture configured.";

// Structurally mirrors FirefliesConnectPanel but simpler: Decision 9's
// workspace toggle has no credential input and no webhook round-trip, just
// a status flip on the workspace's claude_session source_connections row.
export function SessionTrackingPanel({ detail, onChanged, variant }: SessionTrackingPanelProps) {
  const { track } = useAnalytics();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checked = detail?.connected ?? false;

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.request.setSessionTrackingEnabled({ enabled: next });
      if (!result.ok) {
        setError(result.error ?? "Could not update session tracking.");
        return;
      }
      if (next) track("integration_connected", { source: "claude_session" });
      await onChanged();
    } catch {
      setError("Could not update session tracking.");
    } finally {
      setSaving(false);
    }
  }

  const toggleButton = (
    <button
      className={`toggle${checked ? " toggle--on" : ""}${saving ? " toggle--disabled" : ""}`}
      role="switch"
      aria-checked={checked}
      disabled={saving}
      onClick={() => void toggle(!checked)}
    >
      <span className="toggle__thumb" />
    </button>
  );

  if (variant === "settings") {
    return (
      <div className="settings__row">
        <div className="settings__row-content">
          <span className="settings__row-label">Coding sessions</span>
          <span className="settings__row-desc">{DESCRIPTION}</span>
          {error && <span className="settings__save-error" role="alert">{error}</span>}
        </div>
        {toggleButton}
      </div>
    );
  }

  return (
    <section className="onboarding__integration-card">
      <div className="onboarding__integration-header">
        <span className="onboarding__integration-title"><span>Coding Sessions</span><small>{DESCRIPTION}</small></span>
        <span className="onboarding__integration-status">{toggleButton}</span>
      </div>
      {error && <div className="onboarding__integration-content"><span className="onboarding__error">{error}</span></div>}
    </section>
  );
}

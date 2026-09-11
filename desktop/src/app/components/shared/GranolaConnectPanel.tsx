import { useState } from "react";
import type { IntegrationDetail } from "../../../rpc/schema";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { rpc } from "../../rpc";

interface GranolaConnectPanelProps {
  detail: IntegrationDetail | undefined;
  onStatusRefresh: () => boolean | Promise<boolean>;
  onDone: () => void | Promise<void>;
  classPrefix: "onboarding" | "app-row";
}

const REFRESH_ERROR = "Connection saved, but Draft could not refresh its status. Try again in a moment.";

// Unlike Fireflies, Granola's webhook management is itself an API -- Draft
// registers the webhook using the pasted key, so there's no second
// paste-into-vendor-UI step. Connect goes straight from "saving" to "done".
export function GranolaConnectPanel({ onStatusRefresh, onDone, classPrefix }: GranolaConnectPanelProps) {
  const { track } = useAnalytics();
  const [accountKind, setAccountKind] = useState<"personal" | "workspace">("personal");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.request.connectGranola({ apiKey, accountKind });
      if (!result.ok) {
        setError(result.error ?? "Could not connect Granola. Check your API key.");
        return;
      }
      track("integration_connected", { source: "granola" });
      setApiKey("");
      if (await onStatusRefresh()) await onDone();
      else setError(REFRESH_ERROR);
    } catch {
      setError("Could not connect Granola. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`${classPrefix}__connect-panel`}>
      <span className={`${classPrefix}__panel-label`}>Requires a Granola Business or Enterprise plan</span>
      <span className={`${classPrefix}__panel-help`}>Granola only issues API keys on Business and Enterprise plans -- that's also what unlocks webhooks, so nothing further is gated once you have a key.</span>

      <span className={`${classPrefix}__panel-label`}>Key type</span>
      <div className={`${classPrefix}__mode-picker`}>
        <button type="button" className={accountKind === "personal" ? `${classPrefix}__mode--selected` : ""} onClick={() => setAccountKind("personal")}>
          Personal key
        </button>
        <button type="button" className={accountKind === "workspace" ? `${classPrefix}__mode--selected` : ""} onClick={() => setAccountKind("workspace")}>
          Workspace key
        </button>
      </div>
      {accountKind === "personal" ? (
        <span className={`${classPrefix}__panel-help`}>Connects your own Granola notes. Anyone on the team can do this from Granola Settings → Connectors → API keys (Personal notes scope).</span>
      ) : (
        <span className={`${classPrefix}__panel-help`}>
          Workspace key -- for a key created by a <em>Granola</em> workspace admin (Settings → Workspace → General → API access, on Granola's side). Anyone in this Draft workspace can paste one here; Granola is what restricts who can create it, not Draft.
        </span>
      )}

      <button type="button" className={`${classPrefix}__panel-link ${classPrefix}__panel-action`} onClick={() => rpc.send.openUrl({ url: "https://docs.granola.ai/introduction" })}>
        How to get a Granola API key
      </button>
      <input
        className={`${classPrefix}__input`}
        type="password"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        placeholder={accountKind === "personal" ? "Your Granola API key" : "Workspace Granola API key"}
        aria-label="Granola API key"
      />
      {error && <span className={`${classPrefix}__validation`}>{error}</span>}
      <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => void connect()} disabled={saving || !apiKey.trim()}>
        {saving ? "Connecting…" : "Connect Granola"}
      </button>
    </div>
  );
}

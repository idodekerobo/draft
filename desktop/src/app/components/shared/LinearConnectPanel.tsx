import { useState } from "react";
import type { IntegrationDetail } from "../../../rpc/schema";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { rpc } from "../../rpc";

interface LinearConnectPanelProps {
  detail: IntegrationDetail | undefined;
  onConnected: () => void | Promise<void>;
  classPrefix: "onboarding" | "app-row";
}

export function LinearConnectPanel({ onConnected, classPrefix }: LinearConnectPanelProps) {
  const { track } = useAnalytics();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.request.connectLinear({ apiKey });
      if (!result.ok) {
        setError(result.error ?? "Could not connect Linear. Check your API key.");
        return;
      }
      track("integration_connected", { source: "linear" });
      setApiKey("");
      await onConnected();
    } catch {
      setError("Could not connect Linear. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`${classPrefix}__connect-panel`}>
      <span className={`${classPrefix}__panel-label`}>Get your API key</span>
      <span className={`${classPrefix}__panel-help`}>Open Linear Settings → Security & access, then copy a personal API key.</span>
      <button type="button" className={`${classPrefix}__panel-link ${classPrefix}__panel-action`} onClick={() => rpc.send.openUrl({ url: "https://linear.app/settings/api" })}>
        Open Linear API Settings
      </button>
      <input className={`${classPrefix}__input`} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Linear API key" aria-label="Linear API key" />
      {error && <span className={`${classPrefix}__validation`}>{error}</span>}
      <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => void connect()} disabled={saving || !apiKey.trim()}>
        {saving ? "Connecting…" : "Connect Linear"}
      </button>
    </div>
  );
}

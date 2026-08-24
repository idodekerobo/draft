import { useState } from "react";
import type { IntegrationDetail } from "../../../rpc/schema";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { rpc } from "../../rpc";

interface FirefliesConnectPanelProps {
  detail: IntegrationDetail | undefined;
  onStatusRefresh: () => boolean | Promise<boolean>;
  onDone: () => void | Promise<void>;
  classPrefix: "onboarding" | "app-row";
}

interface WebhookInfo {
  webhookUrl: string;
  webhookSecret: string;
}

const REFRESH_ERROR = "Connection saved, but Draft could not refresh its status. Keep this webhook information and try Done again.";

export function FirefliesConnectPanel({ onStatusRefresh, onDone, classPrefix }: FirefliesConnectPanelProps) {
  const { track } = useAnalytics();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webhookInfo, setWebhookInfo] = useState<WebhookInfo | null>(null);
  const [copied, setCopied] = useState<"url" | "secret" | null>(null);

  async function connect() {
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.request.connectFireflies({ apiKey });
      if (!result.ok) {
        setError(result.error ?? "Could not connect Fireflies. Check your API key.");
        return;
      }
      track("integration_connected", { source: "fireflies" });
      setApiKey("");
      if (result.webhookUrl && result.webhookSecret) {
        setWebhookInfo({ webhookUrl: result.webhookUrl, webhookSecret: result.webhookSecret });
        if (!await refreshStatus()) setError(REFRESH_ERROR);
      } else {
        if (await refreshStatus()) await onDone();
        else setError(REFRESH_ERROR);
      }
    } catch {
      setError("Could not connect Fireflies. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function copy(value: string, kind: "url" | "secret") {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1_500);
  }

  async function refreshStatus(): Promise<boolean> {
    try {
      return await onStatusRefresh();
    } catch {
      return false;
    }
  }

  async function finishHandoff() {
    setError(null);
    if (!await refreshStatus()) {
      setError(REFRESH_ERROR);
      return;
    }
    setWebhookInfo(null);
    await onDone();
  }

  if (webhookInfo) {
    return (
      <div className={`${classPrefix}__connect-panel`}>
        <span className={`${classPrefix}__panel-label`}>One-time webhook setup</span>
        <div className={`${classPrefix}__required-callout`} role="note" aria-label="Required final step">
          <span className={`${classPrefix}__required-callout-label`}>Required final step</span>
          <strong>Configure this webhook URL and secret in Fireflies Developer Settings → Webhooks.</strong>
          <span>Subscribe to both <code>meeting.transcribed</code> and <code>meeting.summarized</code>.</span>
        </div>
        <label className={`${classPrefix}__field-label`}>Webhook URL</label>
        <div className={`${classPrefix}__copy-row`}>
          <code>{webhookInfo.webhookUrl}</code>
          <button type="button" onClick={() => void copy(webhookInfo.webhookUrl, "url")}>{copied === "url" ? "Copied" : "Copy"}</button>
        </div>
        <label className={`${classPrefix}__field-label`}>Webhook secret</label>
        <div className={`${classPrefix}__copy-row`}>
          <code>{webhookInfo.webhookSecret}</code>
          <button type="button" onClick={() => void copy(webhookInfo.webhookSecret, "secret")}>{copied === "secret" ? "Copied" : "Copy"}</button>
        </div>
        {error && <span className={`${classPrefix}__validation`}>{error}</span>}
        <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => void finishHandoff()}>
          Done
        </button>
      </div>
    );
  }

  return (
    <div className={`${classPrefix}__connect-panel`}>
      <span className={`${classPrefix}__panel-label`}>Get your API key</span>
      <span className={`${classPrefix}__panel-help`}>Open Fireflies Developer Settings, then copy your API key.</span>
      <button type="button" className={`${classPrefix}__panel-link ${classPrefix}__panel-action`} onClick={() => rpc.send.openUrl({ url: "https://app.fireflies.ai/settings/developer-settings" })}>
        Open Fireflies Developer Settings
      </button>
      <input className={`${classPrefix}__input`} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Fireflies API key" aria-label="Fireflies API key" />
      {error && <span className={`${classPrefix}__validation`}>{error}</span>}
      <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => void connect()} disabled={saving || !apiKey.trim()}>
        {saving ? "Connecting…" : "Connect Fireflies"}
      </button>
    </div>
  );
}

import { useState } from "react";
import type { IntegrationDetail } from "../../../rpc/schema";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { rpc } from "../../rpc";

interface GranolaConnectPanelProps {
  detail: IntegrationDetail | undefined;
  onConnected: () => void | Promise<void>;
  classPrefix: "onboarding" | "app-row";
}

export function GranolaConnectPanel({ onConnected, classPrefix }: GranolaConnectPanelProps) {
  const { track } = useAnalytics();
  const [mode, setMode] = useState<"mcp" | "api">("mcp");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setSaving(true);
    setError(null);
    try {
      const result = mode === "mcp"
        ? await rpc.request.connectGranolaMCP()
        : await rpc.request.connectGranolaAPI({ apiKey });
      if (!result.ok) {
        setError(result.error ?? (mode === "mcp" ? "MCP registration failed. Try API key instead." : "Could not connect Granola."));
        return;
      }
      track("integration_connected", { source: "granola" });
      setApiKey("");
      await onConnected();
    } catch {
      setError(mode === "mcp" ? "MCP registration failed. Try API key instead." : "Could not connect Granola. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`${classPrefix}__connect-panel`}>
      <span className={`${classPrefix}__panel-label`}>Connection method</span>
      <div className={`${classPrefix}__mode-picker`}>
        <button type="button" className={mode === "mcp" ? `${classPrefix}__mode--selected` : ""} onClick={() => setMode("mcp")}>MCP</button>
        <button type="button" className={mode === "api" ? `${classPrefix}__mode--selected` : ""} onClick={() => setMode("api")}>API key</button>
      </div>
      {mode === "mcp" ? (
        <span className={`${classPrefix}__panel-help`}>Register Granola with Claude Code automatically. Authenticate in Claude Code on your next session.</span>
      ) : (
        <input className={`${classPrefix}__input`} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Granola API key" aria-label="Granola API key" />
      )}
      {error && <span className={`${classPrefix}__validation`}>{error}</span>}
      <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => void connect()} disabled={saving || (mode === "api" && !apiKey.trim())}>
        {saving ? "Connecting…" : "Connect Granola"}
      </button>
    </div>
  );
}

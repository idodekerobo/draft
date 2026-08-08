import { useState } from "react";
import type { IntegrationDetail } from "../../../rpc/schema";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { rpc } from "../../rpc";
import { SlackChannelPicker } from "./SlackChannelPicker";

interface SlackConnectPanelProps {
  detail: IntegrationDetail | undefined;
  onConnected: () => void | Promise<void>;
  classPrefix: "onboarding" | "app-row";
  mode?: "connect" | "manage";
}

export function SlackConnectPanel({ detail, onConnected, classPrefix, mode = "connect" }: SlackConnectPanelProps) {
  const { track } = useAnalytics();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [channelIds, setChannelIds] = useState<string[]>(detail?.channelIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openManifest() {
    const result = await rpc.request.getSlackManifestUrl();
    if (result.ok && result.url) rpc.send.openUrl({ url: result.url });
    else {
      rpc.send.openUrl({ url: "https://api.slack.com/apps" });
      setError(result.error ?? "Could not load manifest. Create the app manually.");
    }
    setStep(2);
  }

  async function connect() {
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.request.connectSlack({ botToken, appToken, channelIds });
      if (!result.ok) {
        setError(result.error ?? "Could not connect Slack. Check bot permissions.");
        return;
      }
      track("integration_connected", { source: "slack" });
      setBotToken("");
      setAppToken("");
      setStep(1);
      await onConnected();
    } catch {
      setError("Could not connect Slack. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function updateChannels() {
    setSaving(true);
    setError(null);
    try {
      const result = await rpc.request.updateSlackChannels({ channelIds });
      if (!result.ok) {
        setError(result.error ?? "Could not update Slack channels.");
        return;
      }
      track("integration_channels_updated", { source: "slack" });
      await onConnected();
    } catch {
      setError("Could not update Slack channels. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (mode === "manage") {
    return (
      <div className={`${classPrefix}__connect-panel`}>
        <span className={`${classPrefix}__panel-label`}>Update channels</span>
        <span className={`${classPrefix}__panel-help`}>Choose which public channels Draft should capture. Draft will add the bot to newly selected channels.</span>
        <SlackChannelPicker configuredChannelIds={detail?.channelIds ?? []} selected={channelIds} onChange={setChannelIds} />
        {error && <span className={`${classPrefix}__validation`}>{error}</span>}
        <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => void updateChannels()} disabled={saving || channelIds.length === 0}>
          {saving ? "Saving…" : "Save channels"}
        </button>
      </div>
    );
  }

  return (
    <div className={`${classPrefix}__connect-panel`}>
      <span className={`${classPrefix}__panel-label`}>Step {step} of 3</span>
      {step === 1 && <>
        <span className={`${classPrefix}__panel-help`}>Create a read-only Slack app, then paste the generated tokens back here.</span>
        <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => void openManifest()}>Create Slack app</button>
      </>}
      {step === 2 && <>
        <span className={`${classPrefix}__panel-help`}>Install the app to your workspace, then click <strong>Go to App Settings</strong>. You want to copy the app-level token and bot token into the fields below.</span>
        <label className={`${classPrefix}__field-label`} htmlFor={`${classPrefix}-slack-app-token`}>App-level token</label>
        <span className={`${classPrefix}__hint`}>Found in <strong>Basic Information</strong> → <strong>App-Level Tokens</strong>. Add <code>connections:write</code>.</span>
        <input id={`${classPrefix}-slack-app-token`} className={`${classPrefix}__input`} type="password" value={appToken} onChange={(event) => setAppToken(event.target.value)} placeholder="xapp-..." />
        {appToken.length > 0 && !appToken.startsWith("xapp-") && <span className={`${classPrefix}__validation`}>App-level tokens start with xapp-.</span>}
        <label className={`${classPrefix}__field-label`} htmlFor={`${classPrefix}-slack-bot-token`}>Bot token</label>
        <span className={`${classPrefix}__hint`}>Found in <strong>OAuth &amp; Permissions</strong> → <strong>OAuth Tokens</strong>.</span>
        <input id={`${classPrefix}-slack-bot-token`} className={`${classPrefix}__input`} type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder="xoxb-..." />
        {botToken.length > 0 && !botToken.startsWith("xoxb-") && <span className={`${classPrefix}__validation`}>Bot tokens start with xoxb-.</span>}
        <div className={`${classPrefix}__required-callout`} role="note" aria-label="Required final step">
          <span className={`${classPrefix}__required-callout-label`}>Required final step</span>
          <strong>In Slack, click “Reinstall to Workspace” after copying the bot token.</strong>
          <span>This applies every requested permission to the token you just copied.</span>
        </div>
        <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => setStep(3)} disabled={!botToken.startsWith("xoxb-") || !appToken.startsWith("xapp-")}>Next</button>
      </>}
      {step === 3 && <>
        <span className={`${classPrefix}__panel-help`}>Pick which public channels Draft should capture. Draft will add the bot automatically. For private channels, invite the Draft app from Slack.</span>
        <SlackChannelPicker botToken={botToken} selected={channelIds} onChange={setChannelIds} />
        {error && <span className={`${classPrefix}__validation`}>{error}</span>}
        <button type="button" className={`${classPrefix}__connect ${classPrefix}__panel-action`} onClick={() => void connect()} disabled={saving || channelIds.length === 0}>
          {saving ? "Connecting…" : "Connect Slack"}
        </button>
      </>}
    </div>
  );
}

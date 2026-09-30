"use client";

import { useId } from "react";
import { SettingsRow, Toggle } from "../settings/SettingsRow";

export const ANALYTICS_DOCS_URL = "https://github.com/idodekerobo/draft/blob/main/docs/analytics.md";

export const PRIVACY_COPY = {
  usageLabel: "Share usage data",
  usageHelper:
    "Screens you view, buttons you press and error codes. Never what you type, or file or message content. Linked to your Draft account id, not your name or email. Off by default.",
  replayLabel: "Session replay",
  replayHelper: "Records how you move through the app to help fix bugs. All text and inputs are masked. Needs usage data on.",
  learnMore: "See exactly what we collect",
  changeLater: "You can turn this off any time in Settings.",
};

function LearnMore({ onOpenUrl }: { onOpenUrl?: (url: string) => void }) {
  return (
    <a
      className="ui-link"
      href={ANALYTICS_DOCS_URL}
      target="_blank"
      rel="noreferrer"
      onClick={onOpenUrl ? (event) => { event.preventDefault(); onOpenUrl(ANALYTICS_DOCS_URL); } : undefined}
    >
      {PRIVACY_COPY.learnMore}
    </a>
  );
}

/** Last flow screen: usage analytics only, default off. */
export function ConsentRow({ checked, onChange, onOpenUrl }: { checked: boolean; onChange: (next: boolean) => void; onOpenUrl?: (url: string) => void }) {
  const labelId = useId();
  return (
    <SettingsRow
      label={PRIVACY_COPY.usageLabel}
      labelId={labelId}
      helper={<>{PRIVACY_COPY.usageHelper} {PRIVACY_COPY.changeLater} <LearnMore onOpenUrl={onOpenUrl} /></>}
      control={<Toggle checked={checked} onChange={onChange} labelledBy={labelId} />}
    />
  );
}

/** Renders two list items; place inside a `ui-rows` list. */
export function PrivacyRows({ analyticsConsent, sessionReplay, onAnalyticsChange, onReplayChange, onOpenUrl }: {
  analyticsConsent: boolean;
  sessionReplay: boolean;
  onAnalyticsChange: (next: boolean) => void;
  onReplayChange: (next: boolean) => void;
  onOpenUrl?: (url: string) => void;
}) {
  const usageId = useId();
  const replayId = useId();
  return (
    <>
      <li><SettingsRow
        label={PRIVACY_COPY.usageLabel}
        labelId={usageId}
        helper={<>{PRIVACY_COPY.usageHelper} <LearnMore onOpenUrl={onOpenUrl} /></>}
        control={<Toggle checked={analyticsConsent} onChange={onAnalyticsChange} labelledBy={usageId} />}
      /></li>
      <li><SettingsRow
        label={PRIVACY_COPY.replayLabel}
        labelId={replayId}
        helper={PRIVACY_COPY.replayHelper}
        control={<Toggle checked={sessionReplay && analyticsConsent} onChange={onReplayChange} disabled={!analyticsConsent} labelledBy={replayId} />}
      /></li>
    </>
  );
}

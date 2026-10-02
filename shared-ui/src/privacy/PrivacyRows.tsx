"use client";

import { useId } from "react";
import { SettingsRow, Toggle } from "../settings/SettingsRow";

export const ANALYTICS_DOCS_URL = "https://github.com/idodekerobo/draft/blob/main/docs/analytics.md";

export const PRIVACY_COPY = {
  usageLabel: "Share usage data",
  usageHelper:
    "Screens you view, buttons you press and error codes, plus session replay to help fix bugs. All text and inputs are masked. Never what you type, or file or message content. Linked to your Draft account id, not your name or email. On by default.",
  learnMore: "See exactly what we collect",
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

/** Renders one list item; place inside a `ui-rows` list. */
export function PrivacyRows({ analyticsConsent, onAnalyticsChange, onOpenUrl }: {
  analyticsConsent: boolean;
  onAnalyticsChange: (next: boolean) => void;
  onOpenUrl?: (url: string) => void;
}) {
  const usageId = useId();
  return (
    <li><SettingsRow
      label={PRIVACY_COPY.usageLabel}
      labelId={usageId}
      helper={<>{PRIVACY_COPY.usageHelper} <LearnMore onOpenUrl={onOpenUrl} /></>}
      control={<Toggle checked={analyticsConsent} onChange={onAnalyticsChange} labelledBy={usageId} />}
    /></li>
  );
}

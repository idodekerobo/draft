"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FlowShell, JoinerFlow, type FlowDestination } from "draft-shared-ui";
import { WebToolList } from "@/components/WebToolList";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import { useWorkspace } from "@/lib/workspace";

export default function WelcomePage() {
  const router = useRouter();
  const { track } = useAnalytics();
  const { identity, orgName, context, updatePrivacy, completeOnboarding } = useWorkspace();
  const [error, setError] = useState<string | null>(null);

  if (context.status === "loading") {
    return <FlowShell><p className="ui-muted" role="status">Loading your team&apos;s context…</p></FlowShell>;
  }

  async function finish(destination: FlowDestination) {
    setError(null);
    try {
      // Next and Skip both set the flag, so desktop skips the flow too.
      await completeOnboarding();
      router.replace(destination === "connections" ? "/connections" : "/");
    } catch {
      setError("Could not save your progress. Check your connection and try again.");
    }
  }

  async function changeConsent(next: boolean) {
    setError(null);
    try {
      await updatePrivacy({ analytics_consent: next });
    } catch {
      setError("Could not save your privacy choice. Try again.");
    }
  }

  return (
    <JoinerFlow
      orgName={orgName}
      entries={context.status === "ready" ? context.entries : []}
      toolList={<WebToolList groups={["meetings", "agent", "team"]} />}
      consent={identity.analytics_consent === true}
      onConsentChange={(next) => void changeConsent(next)}
      track={track}
      onFinish={(destination) => void finish(destination)}
      error={error}
    />
  );
}

"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DataBoundary, FlowShell, JoinerFlow, useSuspenseQuery, type FlowDestination } from "draft-shared-ui";
import { documentsToEntries, type ContextFileEntry } from "draft-shared-ui/context-files";
import { WebToolList } from "@/components/WebToolList";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import { apiFetch } from "@/lib/api";
import { contextQueryOptions } from "@/lib/queries";
import { useWorkspace } from "@/lib/workspace";

function Welcome({ entries }: { entries: ContextFileEntry[] }) {
  const router = useRouter();
  const { track } = useAnalytics();
  const { orgName, completeOnboarding } = useWorkspace();
  const [error, setError] = useState<string | null>(null);

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

  return (
    <JoinerFlow
      orgName={orgName}
      entries={entries}
      toolList={<WebToolList groups={["meetings", "agent", "team"]} />}
      track={track}
      onFinish={(destination) => void finish(destination)}
      error={error}
    />
  );
}

function WelcomeWithContext() {
  const { workspaceId } = useWorkspace();
  const { data: snapshot } = useSuspenseQuery(contextQueryOptions(workspaceId, apiFetch));
  const entries = useMemo(() => (snapshot ? documentsToEntries(snapshot.documents) : []), [snapshot]);
  return <Welcome entries={entries} />;
}

export default function WelcomePage() {
  const loading = <FlowShell><p className="ui-muted" role="status">Loading your team&apos;s context…</p></FlowShell>;
  // A failed context fetch still lets people finish onboarding, as before.
  return (
    <DataBoundary fallback={loading} errorFallback={<Welcome entries={[]} />}>
      <WelcomeWithContext />
    </DataBoundary>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AGENT_SETUP_PROMPT,
  buildReadingSources,
  DataBoundary,
  FirstUserFlow,
  FlowShell,
  JoinerFlow,
  useQuery,
  useSuspenseQuery,
  type AgentsStepContent,
  type FlowDestination,
} from "draft-shared-ui";
import { documentsToEntries, type ContextFileEntry } from "draft-shared-ui/context-files";
import { AgentsDownloadActions } from "@/components/AgentsDownloadActions";
import { DesktopNudge } from "@/components/DesktopNudge";
import { WebToolList } from "@/components/WebToolList";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import { apiFetch } from "@/lib/api";
import { connectionsQueryOptions, contextQueryOptions } from "@/lib/queries";
import { webToolStatuses } from "@/lib/tool-statuses";
import { useWorkspace } from "@/lib/workspace";

const WEB_AGENTS_STEP: AgentsStepContent = {
  subtitle: "Invite a teammate into your Claude Code or Codex session. You both prompt the same agent.",
  video: {
    src: "/multiplayer-coding-demo.mp4",
    poster: "/multiplayer-coding-demo-poster.jpg",
    alt: "Two teammates brainstorming with Claude Code in the same Draft session",
  },
  actions: (onContinue) => <AgentsDownloadActions onContinue={onContinue} />,
};

const READING_POLL_MS = 5_000;
const READING_POLL_LIMIT_MS = 10 * 60_000;

function useFinish(destinations: Record<FlowDestination, string>, onChosen?: () => void) {
  const router = useRouter();
  const { completeOnboarding } = useWorkspace();
  const [error, setError] = useState<string | null>(null);

  async function finish(destination: FlowDestination) {
    setError(null);
    try {
      // Next and Skip both set the flag, so desktop skips the full flow too.
      await completeOnboarding();
      onChosen?.();
      router.replace(destinations[destination]);
    } catch {
      setError("Could not save your progress. Check your connection and try again.");
    }
  }
  return { finish, error };
}

function JoinerWelcome({ entries }: { entries: ContextFileEntry[] }) {
  const { track } = useAnalytics();
  const { orgName } = useWorkspace();
  const { finish, error } = useFinish({ connections: "/connections", context: "/sessions" });

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

/** For the person who created the workspace: nothing to read yet, so start with sources. */
function CreatorWelcome() {
  const { track } = useAnalytics();
  const { workspaceId } = useWorkspace();
  const { finish, error } = useFinish(
    { connections: "/connections", context: "/context" },
    () => track("onboarding_finish_chosen", { choice: "web" }),
  );
  const [reading, setReading] = useState(false);
  const [pollingExpired, setPollingExpired] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const { data: connections } = useSuspenseQuery(connectionsQueryOptions(workspaceId, apiFetch));
  const statuses = useMemo(() => webToolStatuses(connections.connections), [connections]);
  const readingSources = useMemo(() => buildReadingSources(statuses), [statuses]);
  const hasSource = Object.entries(statuses).some(
    ([id, status]) => id !== "coding-sessions" && (status?.state === "connected" || status?.state === "pending"),
  );

  // Poll for the first context only while "Draft is reading" is shown, and stop after 10 minutes.
  const { data: snapshot } = useQuery({
    ...contextQueryOptions(workspaceId, apiFetch),
    refetchInterval: reading && !pollingExpired ? READING_POLL_MS : false,
  });
  const entries = useMemo(() => (snapshot ? documentsToEntries(snapshot.documents) : []), [snapshot]);

  useEffect(() => {
    if (!reading) return;
    const timer = setTimeout(() => setPollingExpired(true), READING_POLL_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [reading]);

  // Both ways of finishing (reading, or Skip) show the invite link, and the first request creates it.
  useEffect(() => {
    apiFetch<{ url: string | null }>("/invites/mine")
      .then((body) => setInviteUrl(body.url))
      .catch(() => {});
  }, []);

  return (
    <FirstUserFlow
      toolList={<WebToolList groups={["team", "meetings"]} unavailableHint="Needs the Draft desktop app." />}
      hasSource={hasSource}
      readingSources={readingSources}
      entries={entries}
      inviteUrl={inviteUrl}
      agentPrompt={AGENT_SETUP_PROMPT}
      sourceFooter={<DesktopNudge surface="sources_step" />}
      agentsStep={WEB_AGENTS_STEP}
      readingExtra={<DesktopNudge surface="reading_step" />}
      onReadingChange={setReading}
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
  // Decided once, so context landing mid-flow does not swap the screens under the person.
  const [cohort] = useState<"joiner" | "creator">(() => (entries.length > 0 ? "joiner" : "creator"));
  return cohort === "joiner" ? <JoinerWelcome entries={entries} /> : <CreatorWelcome />;
}

export default function WelcomePage() {
  const loading = <FlowShell><p className="ui-muted" role="status">Loading your team&apos;s context…</p></FlowShell>;
  // A failed context fetch still lets people finish onboarding, as before.
  return (
    <DataBoundary fallback={loading} errorFallback={<JoinerWelcome entries={[]} />}>
      <WelcomeWithContext />
    </DataBoundary>
  );
}

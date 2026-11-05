// DesktopOnboarding.tsx — sign-in pre-flow, then the shared guided flow by workspace state.
// Joiner (context exists): JoinerFlow. First user (empty workspace): FirstUserFlow.

import { SIGNAL_EVENTS, workspaceSignalTopic } from "draft-core/live-sessions";
import { watchSignals } from "../../../liveSessionsApi";
import { useEffect, useState, type ReactNode } from "react";
import { AGENT_SETUP_PROMPT, buildReadingSources, FirstUserFlow, FlowShell, JoinerFlow, useSignals, WORKSPACE_SIGNAL_DELAY_MS, type AgentsStepContent, type FlowDestination, type ReadingSource } from "draft-shared-ui";
import type { ContextFileEntry } from "../../../../rpc/schema";
import { rpc } from "../../../rpc";
import { useAnalytics } from "../../../analytics/AnalyticsContext";
import { useCloudSignIn } from "../../../hooks/useCloudSignIn";
import { useConnectedApps } from "../../../hooks/useConnectedApps";
import { useFolderImport } from "../../../hooks/useFolderImport";
import { useWebAppUrl } from "../../../hooks/useWebAppUrl";
import { useUserIdentity } from "../../../identity/UserIdentityContext";
import { CodexConnectRow } from "../../connections/CodexConnectRow";
import { DesktopToolList, desktopToolStatuses } from "../../connections/DesktopToolList";
import { AgentsSetup } from "./AgentsSetup";

// The context signal brings the first files at once; this poll only covers a missed signal.
const READING_POLL_MS = 30_000;
const READING_POLL_LIMIT_MS = 10 * 60_000;

// Relative to the app's index.html: electrobun.config.ts copies both files next to it.
const DESKTOP_AGENTS_STEP: AgentsStepContent = {
  subtitle: "Get your agents ready, then start a session from the Sessions tab.",
  video: {
    src: "./multiplayer-coding-demo.mp4",
    poster: "./multiplayer-coding-demo-poster.jpg",
    alt: "Two teammates brainstorming with Claude Code in the same Draft session",
  },
  body: <AgentsSetup />,
};

function SignInScreen() {
  const { cloudSignIn, cloudSignInError, handleCloudSignIn } = useCloudSignIn();
  return (
    <FlowShell>
      <h1 className="ui-flow__title">Sign in to Draft</h1>
      <p className="ui-flow__subtitle">Sign in with your browser to connect this computer to your team.</p>
      {cloudSignInError && <p className="ui-error" role="alert">{cloudSignInError}</p>}
      <button type="button" className="ui-btn ui-btn--primary ui-btn--wide" onClick={() => void handleCloudSignIn()} disabled={cloudSignIn === "awaiting_approval"}>
        {cloudSignIn === "awaiting_approval" ? "Finish signing in in your browser…" : "Sign in"}
      </button>
    </FlowShell>
  );
}

function NoTeamScreen() {
  const webUrl = useWebAppUrl();

  // The saved identity says "no team" until it is asked again, so ask whenever the person comes back from the browser.
  useEffect(() => {
    const refresh = () => void rpc.request.refreshUserIdentity().catch(() => {});
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  return (
    <FlowShell>
      <h1 className="ui-flow__title">You&apos;re signed in</h1>
      <p className="ui-flow__subtitle">Create your company in your browser, or open your team&apos;s invite link to join one. This app picks up your team when you come back.</p>
      <button
        type="button"
        className="ui-btn ui-btn--primary ui-btn--wide"
        disabled={!webUrl}
        onClick={() => webUrl && rpc.send.openUrl({ url: `${webUrl}/onboarding/create?src=desktop` })}
      >
        Create your company
      </button>
      <button type="button" className="ui-link" onClick={() => void rpc.request.signOut()}>Use a different account</button>
    </FlowShell>
  );
}

/** The tool list with an optional Codex sign-in under it, for people who run sessions on Codex. */
function WithCodex({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <section className="settings__section">
        <h2 className="settings__section-label">Optional</h2>
        <div className="settings__rows">
          <CodexConnectRow />
        </div>
      </section>
    </>
  );
}

function readingSources(apps: NonNullable<ReturnType<typeof useConnectedApps>["apps"]>, folderImported: boolean): ReadingSource[] {
  const slackChannels = apps.integrations.slack.channels;
  return buildReadingSources(desktopToolStatuses(apps), {
    folderImported,
    details: slackChannels ? { slack: `Reading ${slackChannels} channels` } : undefined,
  });
}

export function DesktopOnboarding({ files, loading, reloadFiles, onComplete }: {
  files: ContextFileEntry[];
  loading: boolean;
  reloadFiles: () => Promise<void>;
  onComplete: (destination: FlowDestination) => void;
}) {
  const identity = useUserIdentity();
  const { track } = useAnalytics();
  const { apps, refresh } = useConnectedApps();
  const [error, setError] = useState<string | null>(null);
  const { imported: folderImported, error: folderError, importFolder } = useFolderImport();
  const [reading, setReading] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  // Cohort is decided once, so the first context landing mid-flow does not switch flows.
  const [cohort, setCohort] = useState<"joiner" | "first_user" | null>(null);

  useEffect(() => {
    if (cohort || loading || !identity.workspaceId) return;
    setCohort(files.length > 0 ? "joiner" : "first_user");
  }, [cohort, loading, files.length, identity.workspaceId]);

  // Needed on the Skip screen as well as after the first context lands, and the first request creates the link.
  useEffect(() => {
    if (cohort !== "first_user") return;
    void rpc.request.getInviteLink().then((result) => { if (result.ok && result.url) setInviteUrl(result.url); }).catch(() => {});
  }, [cohort]);

  // Poll only while "Draft is reading" is shown; stop on success or after 10 minutes.
  useEffect(() => {
    if (!reading || files.length > 0) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > READING_POLL_LIMIT_MS) { clearInterval(timer); return; }
      void refresh();
      void reloadFiles();
    }, READING_POLL_MS);
    return () => clearInterval(timer);
  }, [reading, files.length, refresh, reloadFiles]);

  useSignals(
    reading && files.length === 0 ? watchSignals : undefined,
    identity.workspaceId ? workspaceSignalTopic(identity.workspaceId) : null,
    async (events) => {
      if (events.has(SIGNAL_EVENTS.context) || events.has(SIGNAL_EVENTS.catchUp)) await Promise.all([refresh(), reloadFiles()]);
    },
    WORKSPACE_SIGNAL_DELAY_MS,
  );

  if (!identity.hydrated) return <FlowShell><p className="ui-muted" role="status">Loading…</p></FlowShell>;
  if (!identity.signedIn) return <SignInScreen />;
  if (!identity.workspaceId) return <NoTeamScreen />;
  if (!cohort || !apps) return <FlowShell><p className="ui-muted" role="status">Loading your workspace…</p></FlowShell>;

  async function finish(destination: FlowDestination) {
    setError(null);
    const result = await rpc.request.completeOnboarding().catch(() => ({ ok: false }));
    if (!result.ok) {
      setError("Could not save your progress. Check your connection and try again.");
      return;
    }
    onComplete(destination);
  }

  const statuses = desktopToolStatuses(apps);
  const hasSource = folderImported || Object.values(statuses).some((status) => status?.state === "connected" || status?.state === "pending");

  if (cohort === "joiner") {
    return (
      <JoinerFlow
        orgName="your team"
        entries={files}
        toolList={<WithCodex><DesktopToolList apps={apps} refresh={refresh} groups={["meetings", "agent", "team"]} /></WithCodex>}
        track={track}
        onFinish={(destination) => void finish(destination)}
        error={error}
      />
    );
  }

  return (
    <FirstUserFlow
      toolList={<DesktopToolList apps={apps} refresh={refresh} groups={["team", "meetings"]} startHere="slack" />}
      agentsStep={DESKTOP_AGENTS_STEP}
      hasSource={hasSource}
      readingSources={readingSources(apps, folderImported)}
      entries={files}
      inviteUrl={inviteUrl}
      agentPrompt={AGENT_SETUP_PROMPT}
      onImportFolder={() => void importFolder()}
      onReadingChange={setReading}
      track={track}
      onFinish={(destination) => void finish(destination)}
      error={error ?? folderError}
    />
  );
}

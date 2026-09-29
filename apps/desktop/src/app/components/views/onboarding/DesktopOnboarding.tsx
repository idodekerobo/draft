// DesktopOnboarding.tsx — sign-in pre-flow, then the shared guided flow by workspace state.
// Joiner (context exists): JoinerFlow. First user (empty workspace): FirstUserFlow.

import { useEffect, useState } from "react";
import { DEFAULT_SETUP_DIMENSIONS, FirstUserFlow, FlowShell, JoinerFlow, toDimensionHints, type FlowDestination, type ReadingSource } from "draft-shared-ui";
import type { ContextFileEntry } from "../../../../rpc/schema";
import { events, rpc } from "../../../rpc";
import { useAnalytics } from "../../../analytics/AnalyticsContext";
import { useCloudSignIn } from "../../../hooks/useCloudSignIn";
import { useConnectedApps } from "../../../hooks/useConnectedApps";
import { useUserIdentity } from "../../../identity/UserIdentityContext";
import { DesktopToolList, desktopToolStatuses } from "../../connections/DesktopToolList";

const READING_POLL_MS = 5_000;
const READING_POLL_LIMIT_MS = 10 * 60_000;

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
  return (
    <FlowShell>
      <h1 className="ui-flow__title">You&apos;re signed in</h1>
      <p className="ui-flow__subtitle">Open your team&apos;s invite link in your browser to join. This app picks up your team once you join.</p>
      <button type="button" className="ui-link" onClick={() => void rpc.request.signOut()}>Use a different account</button>
    </FlowShell>
  );
}

function readingSources(apps: NonNullable<ReturnType<typeof useConnectedApps>["apps"]>, folderImported: boolean): ReadingSource[] {
  const statuses = desktopToolStatuses(apps);
  const sources: ReadingSource[] = (["slack", "github", "linear", "fireflies", "granola"] as const)
    .filter((id) => statuses[id] && statuses[id]!.state !== "disconnected")
    .map((id) => ({
      name: { slack: "Slack", github: "GitHub", linear: "Linear", fireflies: "Fireflies", granola: "Granola" }[id],
      status: statuses[id]!,
      detail: id === "slack" && apps.integrations.slack.channels ? `Reading ${apps.integrations.slack.channels} channels` : undefined,
    }));
  if (folderImported) sources.push({ name: "Folder", status: { state: "connected" }, detail: "Uploaded from this computer" });
  return sources;
}

export function DesktopOnboarding({ files, loading, reloadFiles, onComplete }: {
  files: ContextFileEntry[];
  loading: boolean;
  reloadFiles: () => Promise<void>;
  onComplete: (destination: FlowDestination) => void;
}) {
  const identity = useUserIdentity();
  const { track, privacy, setConsent } = useAnalytics();
  const { apps, refresh } = useConnectedApps();
  const [error, setError] = useState<string | null>(null);
  const [folderImported, setFolderImported] = useState(false);
  const [reading, setReading] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  // Cohort is decided once, so the first context landing mid-flow does not switch flows.
  const [cohort, setCohort] = useState<"joiner" | "first_user" | null>(null);

  useEffect(() => {
    if (cohort || loading || !identity.workspaceId) return;
    setCohort(files.length > 0 ? "joiner" : "first_user");
  }, [cohort, loading, files.length, identity.workspaceId]);

  useEffect(() => {
    if (cohort !== "first_user" || files.length === 0) return;
    void rpc.request.getInviteLink().then((result) => { if (result.ok && result.url) setInviteUrl(result.url); }).catch(() => {});
  }, [cohort, files.length]);

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

  async function changeConsent(next: boolean) {
    setError(null);
    try {
      await setConsent(next);
    } catch {
      setError("Could not save your privacy choice. Try again.");
    }
  }

  async function importFolder() {
    setError(null);
    const picked = await rpc.request.selectUploadFolder();
    if (!picked.folderPath) return;
    const result = await rpc.request.bootstrapWorkspaceContext({ folderPath: picked.folderPath, dimensions: toDimensionHints(DEFAULT_SETUP_DIMENSIONS) });
    if (result.ok && result.runId) {
      events.emit("bootstrapRunStarted", { runId: result.runId });
      setFolderImported(true);
    } else {
      setError(result.reason === "no_ready_items" ? "That folder has no files Draft can read. Choose a different one." : result.error ?? "Could not import that folder.");
    }
  }

  const consent = privacy?.analyticsConsent ?? false;
  const statuses = desktopToolStatuses(apps);
  const hasSource = folderImported || Object.values(statuses).some((status) => status?.state === "connected" || status?.state === "pending");

  if (cohort === "joiner") {
    return (
      <JoinerFlow
        orgName="your team"
        entries={files}
        toolList={<DesktopToolList apps={apps} refresh={refresh} groups={["meetings", "agent", "team"]} />}
        consent={consent}
        onConsentChange={(next) => void changeConsent(next)}
        track={track}
        onFinish={(destination) => void finish(destination)}
        onOpenUrl={(url) => rpc.send.openUrl({ url })}
        error={error}
      />
    );
  }

  return (
    <FirstUserFlow
      toolList={<DesktopToolList apps={apps} refresh={refresh} groups={["team", "meetings"]} startHere="slack" />}
      hasSource={hasSource}
      readingSources={readingSources(apps, folderImported)}
      entries={files}
      inviteUrl={inviteUrl}
      agentCommand={apps.agentCommand}
      consent={consent}
      onConsentChange={(next) => void changeConsent(next)}
      onImportFolder={() => void importFolder()}
      onReadingChange={setReading}
      track={track}
      onFinish={(destination) => void finish(destination)}
      onOpenUrl={(url) => rpc.send.openUrl({ url })}
      error={error}
    />
  );
}

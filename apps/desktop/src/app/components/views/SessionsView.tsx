// SessionsView.tsx — live Claude Code sessions of the workspace

import { useCallback, useEffect, useMemo, useState } from "react";
import { isTestedVersion } from "draft-core/harnesses";
import { harnessForModelProvider } from "draft-core/model-provider";
import { SessionStartScreen, SessionView, SessionsLayout, type CloudSnapshotStartRequest, type CloudStartRequest, type LiveSession, type SessionMenuItem, readRecentFolders, rememberFolder, useLiveSessions, useQuery, type HarnessProblem, type StartRequest, type StartResult } from "draft-shared-ui";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { CodexSetupPanel } from "../connections/CodexSetupPanel";
import { liveSessionsApi } from "../../liveSessionsApi";
import { useWebAppUrl } from "../../hooks/useWebAppUrl";
import { useWorkspaceKey } from "../../DesktopQueryProvider";
import { useConnectedApps } from "../../hooks/useConnectedApps";
import { appVersionQueryOptions } from "../../queries";
import { events, rpc } from "../../rpc";
import type { SessionMcpStatusUpdate } from "../../../rpc/schema";

const loadAgentDefaults = (harness: string) => rpc.request.getAgentDefaults({ harness });
// Module-level so the start screen's effect does not run again on every render.
const cloudStart = {
  folderRemote: (folderPath: string) => rpc.request.folderGitRemote({ folderPath }).then(({ gitRemote }) => gitRemote),
  branches: (repo: string) => rpc.request.listGithubBranches({ repo }).then((found) => (found.branches && found.defaultBranch ? { defaultBranch: found.defaultBranch, branches: found.branches } : null)),
  folderSize: (folderPath: string) =>
    rpc.request.snapshotFolderSize({ folderPath }).then((size) => {
      if (!size.ok) throw new Error(size.error);
      return { bytes: size.bytes, fileCount: size.fileCount };
    }),
  envFiles: (folderPath: string) =>
    rpc.request.listSessionEnvFiles({ folderPath }).then((listing) => {
      if (!listing.ok) throw new Error(listing.error);
      return listing.files;
    }),
};
const REVEAL_LABEL = /Windows/i.test(navigator.userAgent) ? "Open in Explorer" : "Reveal in Finder";

/** The webview has no process.env, so a dev build is read from the app channel. */
function useDevOnlyVersionWarnings(): boolean {
  return useQuery(appVersionQueryOptions).data?.channel === "dev";
}

function SessionDetail({ sessionId, onOpenSession, justStarted, menuItems, notice, onDeleted }: {
  sessionId: string;
  onOpenSession: (id: string) => void;
  justStarted: boolean;
  menuItems: (session: LiveSession) => SessionMenuItem[];
  notice: string | null;
  onDeleted: () => void;
}) {
  const [mcp, setMcp] = useState<SessionMcpStatusUpdate | null>(null);
  const hosted = useHostedSessionIds();
  useEffect(() => {
    let active = true;
    const accept = (update: SessionMcpStatusUpdate) => {
      if (active && update.sessionId === sessionId) setMcp((current) => !current || update.revision >= current.revision ? update : current);
    };
    const unsubscribe = events.on("sessionMcpStatus", accept);
    void rpc.request.getSessionMcpStatus({ sessionId }).then(accept).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [sessionId]);
  const toolsNotice = hosted.has(sessionId) && mcp?.status?.state === "unavailable"
    ? mcp.status.reason === "sign_in_required" ? "Sign in to Draft to restore Draft tools." : "Draft tools are unavailable. Coding can continue while Draft reconnects."
    : null;
  const { track } = useAnalytics();
  const webAppUrl = useWebAppUrl();
  const devOnlyVersionWarnings = useDevOnlyVersionWarnings();

  return (
    <SessionView
      api={liveSessionsApi}
      sessionId={sessionId}
      menuItems={menuItems}
      onDeleted={onDeleted}
      notice={notice}
      toolsNotice={toolsNotice}
      onOpenSession={onOpenSession}
      autoFocusComposer={justStarted}
      track={track}
      shareBaseUrl={webAppUrl}
      devOnly={devOnlyVersionWarnings}
      agentDefaults={loadAgentDefaults}
    />
  );
}

/** The ids of the live sessions that run on this computer, checked every few seconds. */
function useHostedSessionIds(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let cancelled = false;
    const check = () =>
      void rpc.request.getHostedLiveSessionIds().then((hosted) => {
        if (!cancelled) setIds(new Set(hosted));
      }).catch(() => {});
    check();
    const timer = setInterval(check, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return ids;
}

export function SessionsView({ onOpenConnections }: { onOpenConnections?: () => void } = {}) {
  const devOnlyVersionWarnings = useDevOnlyVersionWarnings();
  const { apps } = useConnectedApps();
  const githubConnected = apps ? apps.integrations.github.connected : null;
  const cloud = useMemo(() => ({ ...cloudStart, githubConnected, onConnectGithub: onOpenConnections }), [githubConnected, onOpenConnections]);
  const workspaceKey = useWorkspaceKey();
  // The workspace's lab decides which harness a new session starts with. A failed read leaves Claude, the default.
  const modelProvider = useQuery({ queryKey: ["model-provider", workspaceKey], queryFn: () => rpc.request.getModelProvider(), staleTime: 5 * 60_000 });
  const { track } = useAnalytics();
  const { sessions, refetch, isPending, isError } = useLiveSessions(liveSessionsApi, workspaceKey);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const hostedIds = useHostedSessionIds();
  const [notice, setNotice] = useState<string | null>(null);

  const menuItems = useCallback(
    (session: LiveSession): SessionMenuItem[] => {
      if (!hostedIds.has(session.id) || session.status === "ended") return [];
      const run = (request: () => Promise<{ ok: true } | { ok: false; error: string }>) => async () => {
        setNotice(null);
        const result = await request();
        if (!result.ok) setNotice(result.error);
      };
      return [
        { label: REVEAL_LABEL, onSelect: run(() => rpc.request.revealLiveSessionFolder({ sessionId: session.id })) },
        { label: "Open in Terminal", onSelect: run(() => rpc.request.openLiveSessionInTerminal({ sessionId: session.id })) },
        { label: "End session", onSelect: run(() => rpc.request.endLiveSession({ sessionId: session.id })), confirm: "End this session? Claude exits and nobody can send to it again." },
      ];
    },
    [hostedIds],
  );
  const onDeleted = useCallback(
    (id: string) => {
      void refetch();
      setSelectedId((current) => (current === id ? null : current));
    },
    [refetch],
  );
  const [recentFolders, setRecentFolders] = useState(() => readRecentFolders(window.localStorage));

  const [availability, setAvailability] = useState<Partial<Record<string, HarnessProblem>>>({});
  const loadAvailability = useCallback(() => {
    void rpc.request.getAvailableHarnesses().then(({ harnesses }) => {
      const next: Partial<Record<string, HarnessProblem>> = {};
      for (const harness of harnesses) {
        if (!harness.installed) next[harness.name] = "missing";
        else if (harness.auth === "signed_out") next[harness.name] = "signed_out";
        else if (isTestedVersion(harness.name, harness.version) === false) next[harness.name] = "untested_version";
      }
      setAvailability(next);
    }).catch(() => {});
  }, []);
  useEffect(loadAvailability, [loadAvailability]);

  async function browse(): Promise<string | null> {
    return (await rpc.request.selectSetupFolder()).folderPath;
  }

  /** A repository is sent as it is. A folder is packed and uploaded first, and the start names the upload it made. */
  async function startCloud(request: CloudStartRequest | CloudSnapshotStartRequest, progress?: (step: string) => void): Promise<{ ok: true; sessionId: string } | { ok: false; error: string; detail?: string }> {
    const common = { runtime: "cloud" as const, model: request.model, effort: request.effort, ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}), network: request.network };
    if (request.source === "repo") {
      if (!request.gitRemote) return rpc.request.startLiveSession({ ...common, seed: { kind: "empty" as const } });
      return rpc.request.startLiveSession({ ...common, seed: { kind: "repo" as const, gitRemote: request.gitRemote, branch: request.branch } });
    }
    progress?.("Copying folder…");
    const upload = await rpc.request.uploadSessionSnapshot({ folderPath: request.folderPath, includeEnvFiles: request.includeEnvFiles });
    if (!upload.ok) return { ok: false, error: upload.error, ...(upload.detail ? { detail: upload.detail } : {}) };
    progress?.("Starting…");
    return rpc.request.startLiveSession({
      ...common,
      seed: { kind: "snapshot" as const, sessionId: upload.sessionId, storageKey: upload.storageKey, folderName: upload.folderName },
    });
  }

  async function start(request: StartRequest, progress?: (step: string) => void): Promise<StartResult> {
    const { harness, model, effort } = request;
    const result = request.runtime === "cloud"
      ? await startCloud(request, progress)
      : await rpc.request.startLiveSession({ harness, folderPath: request.folderPath, model, effort, ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}), ...(request.approvalMode ? { approvalMode: request.approvalMode } : {}) });
    if (!result.ok) return result;
    try {
      await liveSessionsApi.sendMessage(result.sessionId, request.text);
    } catch (error) {
      await refetch();
      return { ok: false, error: `The session was created, but its first input could not be queued. Open it from the session list to retry. ${error instanceof Error ? error.message : ""}` };
    }
    track("session_started", { live_session_id: result.sessionId, harness, model: model ?? "default", effort: effort ?? "default", runtime: request.runtime ?? "local" });
    if (request.runtime !== "cloud") setRecentFolders(rememberFolder(window.localStorage, request.folderPath));
    await refetch();
    setStartedId(result.sessionId);
    setSelectedId(result.sessionId);
    return { ok: true };
  }

  return (
    <SessionsLayout
      sessions={sessions}
      loading={isPending}
      failed={isError}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onNew={() => setSelectedId(null)}
      api={liveSessionsApi}
      menuItems={menuItems}
      onDeleted={onDeleted}
      resizable
    >
      {selectedId ? <SessionDetail key={selectedId} sessionId={selectedId} onOpenSession={setSelectedId} justStarted={selectedId === startedId} menuItems={menuItems} notice={notice} onDeleted={() => onDeleted(selectedId)} /> : <SessionStartScreen defaultHarness={harnessForModelProvider(modelProvider.data?.provider)} devOnly={devOnlyVersionWarnings} agentDefaults={loadAgentDefaults} availability={availability} renderSetup={(harness) => (harness === "codex" ? <CodexSetupPanel onStatusChange={loadAvailability} /> : null)} recentFolders={recentFolders} onBrowse={browse} onStart={start} cloud={cloud} />}
    </SessionsLayout>
  );
}

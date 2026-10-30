// SessionsView.tsx — live Claude Code sessions of the workspace

import { useCallback, useEffect, useState } from "react";
import { isTestedVersion } from "draft-core/harnesses";
import { SessionStartScreen, SessionView, SessionsLayout, readRecentFolders, rememberFolder, useLiveSessions, type HarnessProblem, type StartRequest, type StartResult } from "draft-shared-ui";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import { CodexSetupPanel } from "../connections/CodexSetupPanel";
import { liveSessionsApi } from "../../liveSessionsApi";
import { useWebAppUrl } from "../../hooks/useWebAppUrl";
import { useWorkspaceKey } from "../../DesktopQueryProvider";
import { rpc } from "../../rpc";

function SessionDetail({ sessionId, onOpenSession, justStarted }: { sessionId: string; onOpenSession: (id: string) => void; justStarted: boolean }) {
  const { track } = useAnalytics();
  const webAppUrl = useWebAppUrl();
  const [hostedHere, setHostedHere] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () =>
      void rpc.request.getHostedLiveSessionIds().then((ids) => {
        if (!cancelled) setHostedHere(ids.includes(sessionId));
      });
    check();
    const timer = setInterval(check, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId]);

  async function openInTerminal() {
    setNotice(null);
    const result = await rpc.request.openLiveSessionInTerminal({ sessionId });
    if (!result.ok) setNotice(result.error);
  }

  async function endSession() {
    setNotice(null);
    const result = await rpc.request.endLiveSession({ sessionId });
    if (!result.ok) setNotice(result.error);
  }

  return (
    <SessionView
      api={liveSessionsApi}
      sessionId={sessionId}
      menuItems={(session) =>
        hostedHere && session.status !== "ended"
          ? [
              { label: "Open in Terminal", onSelect: openInTerminal },
              { label: "End session", onSelect: endSession, confirm: "End this session? Claude exits and nobody can send to it again." },
            ]
          : []
      }
      notice={notice}
      onOpenSession={onOpenSession}
      autoFocusComposer={justStarted}
      track={track}
      shareBaseUrl={webAppUrl}
    />
  );
}

export function SessionsView() {
  const workspaceKey = useWorkspaceKey();
  const { track } = useAnalytics();
  const { sessions, refetch, isPending, isError } = useLiveSessions(liveSessionsApi, workspaceKey);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [recentFolders, setRecentFolders] = useState(() => readRecentFolders(window.localStorage));

  const [availability, setAvailability] = useState<Partial<Record<string, HarnessProblem>>>({});
  const loadAvailability = useCallback(() => {
    void rpc.request.getAvailableRunners().then(({ runners }) => {
      const next: Partial<Record<string, HarnessProblem>> = {};
      for (const runner of runners) {
        if (!runner.installed) next[runner.name] = "missing";
        else if (runner.auth === "signed_out") next[runner.name] = "signed_out";
        else if (isTestedVersion(runner.name, runner.version) === false) next[runner.name] = "untested_version";
      }
      setAvailability(next);
    }).catch(() => {});
  }, []);
  useEffect(loadAvailability, [loadAvailability]);

  async function browse(): Promise<string | null> {
    return (await rpc.request.selectSetupFolder()).folderPath;
  }

  async function start({ harness, folderPath, text, model }: StartRequest): Promise<StartResult> {
    const result = await rpc.request.startLiveSession({ harness, folderPath, model });
    if (!result.ok) return result;
    track("session_started", { live_session_id: result.sessionId, harness, model: model ?? "default" });
    setRecentFolders(rememberFolder(window.localStorage, folderPath));
    // The host types the first message once Claude is ready; a failure here leaves an empty session the user can type into.
    await liveSessionsApi.sendMessage(result.sessionId, text).catch((error) => console.error("[sessions] first message failed", error));
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
      resizable
    >
      {selectedId ? <SessionDetail key={selectedId} sessionId={selectedId} onOpenSession={setSelectedId} justStarted={selectedId === startedId} /> : <SessionStartScreen availability={availability} renderSetup={(harness) => (harness === "codex" ? <CodexSetupPanel onStatusChange={loadAvailability} /> : null)} recentFolders={recentFolders} onBrowse={browse} onStart={start} />}
    </SessionsLayout>
  );
}

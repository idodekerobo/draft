// SessionsView.tsx — live Claude Code sessions of the workspace

import { useEffect, useState } from "react";
import { SessionStartScreen, SessionView, SessionsLayout, readRecentFolders, rememberFolder, useLiveSessions, type StartResult } from "draft-shared-ui";
import { liveSessionsApi } from "../../liveSessionsApi";
import { useWorkspaceKey } from "../../DesktopQueryProvider";
import { rpc } from "../../rpc";

function SessionDetail({ sessionId }: { sessionId: string }) {
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
    />
  );
}

export function SessionsView() {
  const workspaceKey = useWorkspaceKey();
  const { sessions, refetch, isPending, isError } = useLiveSessions(liveSessionsApi, workspaceKey);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recentFolders, setRecentFolders] = useState(() => readRecentFolders(window.localStorage));

  async function browse(): Promise<string | null> {
    return (await rpc.request.selectSetupFolder()).folderPath;
  }

  async function start(folderPath: string, text: string): Promise<StartResult> {
    const result = await rpc.request.startLiveSession({ folderPath });
    if (!result.ok) return result;
    setRecentFolders(rememberFolder(window.localStorage, folderPath));
    // The host types the first message once Claude is ready; a failure here leaves an empty session the user can type into.
    await liveSessionsApi.sendMessage(result.sessionId, text).catch((error) => console.error("[sessions] first message failed", error));
    await refetch();
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
      {selectedId ? <SessionDetail key={selectedId} sessionId={selectedId} /> : <SessionStartScreen recentFolders={recentFolders} onBrowse={browse} onStart={start} />}
    </SessionsLayout>
  );
}

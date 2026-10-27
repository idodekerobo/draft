// SessionsView.tsx — live Claude Code sessions of the workspace

import { useEffect, useState } from "react";
import { SessionView, SessionsList, useLiveSessions } from "draft-shared-ui";
import { liveSessionsApi } from "../../liveSessionsApi";
import { useWorkspaceKey } from "../../DesktopQueryProvider";
import { rpc } from "../../rpc";

function SessionDetail({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
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

  return (
    <SessionView
      api={liveSessionsApi}
      sessionId={sessionId}
      back={<button type="button" className="ui-link" onClick={onBack}>Sessions</button>}
      menuItems={(session) => (hostedHere && session.status !== "ended" ? [{ label: "Open in Terminal", onSelect: openInTerminal }] : [])}
      notice={notice}
    />
  );
}

export function SessionsView() {
  const workspaceKey = useWorkspaceKey();
  const { sessions, refetch, isPending, isError } = useLiveSessions(liveSessionsApi, workspaceKey);
  const [openId, setOpenId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startSession() {
    setError(null);
    const { folderPath } = await rpc.request.selectSetupFolder();
    if (!folderPath) return;
    setStarting(true);
    try {
      const result = await rpc.request.startLiveSession({ folderPath });
      if (!result.ok) setError(result.error);
      else {
        await refetch();
        setOpenId(result.sessionId);
      }
    } finally {
      setStarting(false);
    }
  }

  if (openId) return <SessionDetail sessionId={openId} onBack={() => setOpenId(null)} />;

  return (
    <div className="ui-page">
      <h1 className="ui-page__title">Sessions</h1>
      <p className="ui-page__intro">Live Claude Code sessions from your team.</p>
      <p>
        <button type="button" className="ui-btn ui-btn--primary" onClick={startSession} disabled={starting}>
          {starting ? "Starting…" : "New session"}
        </button>
      </p>
      {error && <p className="ui-error" role="alert">{error}</p>}
      <SessionsList sessions={sessions} loading={isPending} failed={isError} onOpen={setOpenId} />
    </div>
  );
}

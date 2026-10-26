// SessionsView.tsx — live Claude Code sessions of the workspace

import { useState } from "react";
import { SessionStream, SessionsList, sessionTitle, useLiveSessions, useSessionStream } from "draft-shared-ui";
import { liveSessionsApi } from "../../liveSessionsApi";
import { useWorkspaceKey } from "../../DesktopQueryProvider";
import { rpc } from "../../rpc";

function SessionDetail({ sessionId, onBack }: { sessionId: string; onBack: () => void }) {
  const { session, events, error } = useSessionStream(liveSessionsApi, sessionId);
  return (
    <div className="ui-page">
      <p><button type="button" className="ui-link" onClick={onBack}>Sessions</button></p>
      <h1 className="ui-page__title">{session ? sessionTitle(session) : "Session"}</h1>
      {session && <p className="ui-page__intro">{session.owner_name ?? "Someone"} · {session.status.replace("_", " ")}</p>}
      {error && !session ? <p className="ui-error" role="alert">Could not load this session.</p> : <SessionStream events={events} ownerName={session?.owner_name ?? undefined} />}
    </div>
  );
}

export function SessionsView() {
  const workspaceKey = useWorkspaceKey();
  const { sessions, refetch } = useLiveSessions(liveSessionsApi, workspaceKey);
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
      <SessionsList sessions={sessions} onOpen={setOpenId} />
    </div>
  );
}

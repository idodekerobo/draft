"use client";

import { useRouter } from "next/navigation";
import { SessionsList } from "draft-shared-ui";
import { useWebLiveSessions } from "@/lib/live-sessions";

export default function SessionsPage() {
  const router = useRouter();
  const { sessions, enabled, isPending } = useWebLiveSessions();
  return (
    <div className="ui-page">
      <h1 className="ui-page__title">Sessions</h1>
      <p className="ui-page__intro">Live Claude Code sessions from your team.</p>
      {isPending ? (
        <p className="ui-muted" role="status">Loading sessions…</p>
      ) : enabled ? (
        <SessionsList sessions={sessions} onOpen={(id) => router.push(`/sessions/${id}`)} />
      ) : (
        <p className="ui-muted">Live sessions are not turned on for this workspace.</p>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { use } from "react";
import { SessionComposer, SessionStream, sessionTitle, useSessionInputs, useSessionStream } from "draft-shared-ui";
import { useWebLiveSessions } from "@/lib/live-sessions";

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { api } = useWebLiveSessions();
  const { session, events, error } = useSessionStream(api, id);
  const inputs = useSessionInputs(api, id);
  return (
    <div className="ui-page">
      <p><Link href="/sessions">Sessions</Link></p>
      <h1 className="ui-page__title">{session ? sessionTitle(session) : "Session"}</h1>
      {session && (
        <p className="ui-page__intro">{session.owner_name ?? "Someone"} · {session.status.replace("_", " ")}</p>
      )}
      {error && !session ? <p className="ui-error" role="alert">Could not load this session.</p> : <SessionStream events={events} ownerName={session?.owner_name ?? undefined} />}
      {session && <SessionComposer {...inputs} ownerName={session.owner_name ?? "the owner"} ended={session.status === "ended"} />}
    </div>
  );
}

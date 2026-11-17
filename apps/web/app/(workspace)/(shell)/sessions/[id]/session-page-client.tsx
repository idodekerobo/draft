"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { use } from "react";
import { MESSAGE_PARAM, SessionView, parseMessageParam } from "draft-shared-ui";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import { useWebLiveSessions } from "@/lib/live-sessions";
import { useSessionEntry } from "@/lib/session-entry";
import { createClient } from "@/lib/supabase/client";
import { useWorkspace } from "@/lib/workspace";

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { api } = useWebLiveSessions();
  const router = useRouter();
  const search = useSearchParams();
  const { identity } = useWorkspace();
  const { track } = useAnalytics();
  const { entryFor, markInAppNavigation } = useSessionEntry();

  async function switchAccount() {
    await createClient().auth.signOut();
    location.assign(`/login?next=${encodeURIComponent(`/sessions/${id}${location.search}`)}`);
  }

  return (
    <SessionView
      api={api}
      sessionId={id}
      back={<Link href="/sessions" className="ui-link">Sessions</Link>}
      onOpenSession={(sessionId) => {
        markInAppNavigation();
        router.push(`/sessions/${sessionId}`);
      }}
      track={track}
      entry={entryFor(id)}
      shareBaseUrl={typeof window === "undefined" ? undefined : window.location.origin}
      focusSeq={parseMessageParam(search.get(MESSAGE_PARAM))}
      noAccessNote={
        <>
          Signed in as {identity.email}.{" "}
          <button type="button" className="ui-link" onClick={() => void switchAccount()}>Switch account</button>
        </>
      }
    />
  );
}

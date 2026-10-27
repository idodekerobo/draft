"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use } from "react";
import { SessionView } from "draft-shared-ui";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import { useWebLiveSessions } from "@/lib/live-sessions";
import { useSessionEntry } from "@/lib/session-entry";

export default function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { api } = useWebLiveSessions();
  const router = useRouter();
  const { track } = useAnalytics();
  const { entryFor, markInAppNavigation } = useSessionEntry();
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
    />
  );
}

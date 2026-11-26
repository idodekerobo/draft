"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { HomeView } from "draft-shared-ui";
import { homeThreadApi } from "@/lib/home-thread";
import { liveSessionsApi } from "@/lib/live-sessions-api";
import { useWorkspace } from "@/lib/workspace";

export default function HomePage() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const highlightId = useSearchParams().get("n");
  const thread = useMemo(() => ({ api: liveSessionsApi(workspaceId), home: homeThreadApi(workspaceId) }), [workspaceId]);
  return (
    <div className="ui-page">
      <HomeView
        workspaceId={workspaceId}
        highlightId={highlightId}
        thread={thread}
        onOpenSession={(sessionId) => router.push(`/sessions/${sessionId}`)}
        onOpenRun={(runId) => router.push(`/routines/runs/${runId}`)}
        onOpenConnections={() => router.push("/connections")}
        onOpenRoutines={() => router.push("/routines")}
      />
    </div>
  );
}

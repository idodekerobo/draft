"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { HomeView } from "draft-shared-ui";
import { useWorkspace } from "@/lib/workspace";

export default function HomePage() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const highlightId = useSearchParams().get("n");
  return (
    <div className="ui-page">
      <HomeView
        workspaceId={workspaceId}
        highlightId={highlightId}
        onOpenSession={(sessionId) => router.push(`/sessions/${sessionId}`)}
        onOpenRun={(runId) => router.push(`/routines/runs/${runId}`)}
        onOpenConnections={() => router.push("/connections")}
        onOpenRoutines={() => router.push("/routines")}
      />
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { DataBoundary, RoutinesPanel, RoutinesSkeleton } from "draft-shared-ui";
import { useWorkspace } from "@/lib/workspace";

export default function RoutinesPage() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  return (
    <div className="ui-page">
      <DataBoundary fallback={<RoutinesSkeleton />} errorMessage="Could not load routines.">
        <RoutinesPanel workspaceId={workspaceId} onReconnect={() => router.push("/connections")} />
      </DataBoundary>
    </div>
  );
}

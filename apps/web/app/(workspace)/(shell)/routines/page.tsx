"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { RoutinesPanel } from "draft-shared-ui";
import { useWorkspace } from "@/lib/workspace";

const ROUTINE_PARAM = "routine";

export default function RoutinesPage() {
  const router = useRouter();
  const search = useSearchParams();
  const { workspaceId } = useWorkspace();
  // A run leaves this page with the routine in the URL, so browser Back reopens its details.
  const [initialOpenId] = useState(() => search.get(ROUTINE_PARAM) ?? undefined);

  useEffect(() => {
    if (initialOpenId) window.history.replaceState(null, "", "/routines");
  }, [initialOpenId]);

  return (
    <div className="ui-routines-page">
      <RoutinesPanel
        workspaceId={workspaceId}
        initialOpenId={initialOpenId}
        onReconnect={() => router.push("/connections")}
        onOpenRun={(sessionId, routine) => {
          window.history.replaceState(null, "", `/routines?${ROUTINE_PARAM}=${routine.id}`);
          router.push(`/routines/runs/${sessionId}`);
        }}
      />
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { RoutinesPanel } from "draft-shared-ui";
import { useWorkspace } from "@/lib/workspace";

export default function RoutinesPage() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  return (
    <div className="ui-routines-page">
      <RoutinesPanel workspaceId={workspaceId} onReconnect={() => router.push("/connections")} />
    </div>
  );
}

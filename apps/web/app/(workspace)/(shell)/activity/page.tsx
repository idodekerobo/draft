"use client";

import { useRouter } from "next/navigation";
import { ActivityPanel } from "draft-shared-ui";
import { useWorkspace } from "@/lib/workspace";

export default function ActivityPage() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  return (
    <div className="ui-page">
      <ActivityPanel workspaceId={workspaceId} onFixInConnections={() => router.push("/connections")} />
    </div>
  );
}

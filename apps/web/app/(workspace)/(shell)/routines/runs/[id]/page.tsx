"use client";

import { useRouter } from "next/navigation";
import { use, useMemo } from "react";
import { BackButton, SessionView } from "draft-shared-ui";
import { liveSessionsApi } from "@/lib/live-sessions-api";
import { useWorkspace } from "@/lib/workspace";

export default function RoutineRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const api = useMemo(() => liveSessionsApi(workspaceId), [workspaceId]);
  // Back follows the browser's history. A person who opened a shared link has none, so they go to the list.
  const goBack = () => (window.history.length > 1 ? router.back() : router.push("/routines"));
  return <SessionView api={api} sessionId={id} back={<BackButton onClick={goBack} />} />;
}

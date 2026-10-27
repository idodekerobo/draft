"use client";

import Link from "next/link";
import { use, useMemo } from "react";
import { SessionView } from "draft-shared-ui";
import { liveSessionsApi } from "@/lib/live-sessions-api";
import { useWorkspace } from "@/lib/workspace";

export default function RoutineRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { workspaceId } = useWorkspace();
  const api = useMemo(() => liveSessionsApi(workspaceId), [workspaceId]);
  return <SessionView api={api} sessionId={id} back={<Link href="/routines" className="ui-link">Routines</Link>} />;
}

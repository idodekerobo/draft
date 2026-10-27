"use client";

import { useMemo } from "react";
import { useLiveSessions } from "draft-shared-ui";
import { liveSessionsApi } from "@/lib/live-sessions-api";
import { useWorkspace } from "@/lib/workspace";

export function useWebLiveSessions() {
  const { workspaceId } = useWorkspace();
  const api = useMemo(() => liveSessionsApi(workspaceId), [workspaceId]);
  return { api, workspaceId, ...useLiveSessions(api, workspaceId) };
}

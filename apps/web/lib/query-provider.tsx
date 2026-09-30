"use client";

import { DraftQueryProvider, type DraftApi, type SynthesisRunSummary } from "draft-shared-ui";
import type { ReactNode } from "react";
import { apiFetch } from "@/lib/api";

export function WebQueryProvider({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const api: DraftApi = {
    getRuns: async () => (await apiFetch<{ runs: SynthesisRunSummary[] }>(`/workspaces/${workspaceId}/synthesis-runs`)).runs,
  };
  return <DraftQueryProvider api={api}>{children}</DraftQueryProvider>;
}

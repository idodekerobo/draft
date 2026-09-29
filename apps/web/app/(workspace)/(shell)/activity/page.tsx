"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ActivityList, type SynthesisRunSummary } from "draft-shared-ui";
import { apiFetch } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";

const POLL_MS = 30_000;

export default function ActivityPage() {
  const router = useRouter();
  const { workspaceId } = useWorkspace();
  const [runs, setRuns] = useState<SynthesisRunSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const body = await apiFetch<{ runs: SynthesisRunSummary[] }>(`/workspaces/${workspaceId}/synthesis-runs`);
      setRuns(body.runs);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="ui-page">
      <h1 className="ui-page__title">Activity</h1>
      {failed && (
        <p className="ui-error" role="alert">
          Could not load activity. <button type="button" className="ui-link" onClick={() => void refresh()}>Try again</button>
        </p>
      )}
      {!runs && !failed && <p className="ui-muted" role="status">Loading activity…</p>}
      {runs && <ActivityList runs={runs} onFixInConnections={() => router.push("/connections")} />}
    </div>
  );
}

import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { getRunDetail, getStepRunTranscript } from "../activity/run-detail";

type RunRequest = Bun.BunRequest<"/workspaces/:id/runs/:runId">;
type TranscriptRequest = Bun.BunRequest<"/workspaces/:id/runs/:runId/transcript">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One run of a routine or of synthesis, with its steps. */
export const GET = withAuth<RunRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  if (!UUID.test(req.params.runId)) return Response.json({ error: "run_not_found" }, { status: 404 });
  try {
    const result = await getRunDetail(serviceClient, req.params.id, req.params.runId, caller.userId);
    return result.ok ? Response.json(result.detail) : Response.json({ error: "run_not_found" }, { status: 404 });
  } catch (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "read", errorCode: "run_detail_read_failed", error });
    return Response.json({ error: "run_detail_read_failed" }, { status: 500 });
  }
});

/** What one step run did, as plain lines. */
export const TRANSCRIPT = withAuth<TranscriptRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  if (!UUID.test(req.params.runId)) return Response.json({ error: "run_not_found" }, { status: 404 });
  try {
    const transcript = await getStepRunTranscript(serviceClient, req.params.id, req.params.runId, caller.userId);
    return transcript ? Response.json(transcript) : Response.json({ error: "run_not_found" }, { status: 404 });
  } catch (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "read", errorCode: "run_transcript_read_failed", error });
    return Response.json({ error: "run_transcript_read_failed" }, { status: 500 });
  }
});

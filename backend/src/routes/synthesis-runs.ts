import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { loadSandboxDeploymentConfig } from "../sandbox";
import { getReadySourceItemIds } from "../synthesis/get-ready-source-items";
import { launchSynthesisRun } from "../synthesis/orchestrate-run";
import { RunNotAllowedError } from "../synthesis/check-run-allowed";
import { WorkspaceRunAlreadyActiveError } from "../synthesis/prepare-run";
import type { DimensionHint } from "../synthesis/types";
import { recordRouteError } from "../errors/route-error";
import type { SynthesisRunRow } from "../types/tables";

type SynthesisRunsRequest = Bun.BunRequest<"/workspaces/:id/synthesis-runs">;

const RUNS_LIST_LIMIT = 50;

type SynthesisRunListRow = Pick<
  SynthesisRunRow,
  "id" | "status" | "outcome" | "trigger_type" | "result_summary" | "started_at" | "completed_at" | "created_at"
>;

export const GET = withAuth<SynthesisRunsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const { data, error } = await serviceClient
    .from("synthesis_runs")
    .select("id, status, outcome, trigger_type, result_summary, started_at, completed_at, created_at")
    .eq("workspace_id", req.params.id)
    .order("created_at", { ascending: false })
    .limit(RUNS_LIST_LIMIT)
    .returns<SynthesisRunListRow[]>();

  if (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "read", errorCode: "synthesis_runs_read_failed", error });
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({
    runs: (data ?? []).map((run) => ({
      id: run.id,
      status: run.status,
      outcome: run.outcome,
      triggerType: run.trigger_type,
      resultSummary: run.result_summary,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      createdAt: run.created_at,
    })),
  });
});

interface SynthesisRunsBody {
  dimensions?: DimensionHint[];
}

function isDimensionHint(value: unknown): value is DimensionHint {
  if (!value || typeof value !== "object") return false;
  const hint = value as Partial<DimensionHint>;
  return typeof hint.dimensionName === "string" && typeof hint.dimensionDescription === "string";
}

function isSynthesisRunsBody(value: unknown): value is SynthesisRunsBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<SynthesisRunsBody>;
  return body.dimensions === undefined || (Array.isArray(body.dimensions) && body.dimensions.every(isDimensionHint));
}

function errorResponse(error: string, status = 500, detail?: unknown, workspaceId?: string): Response {
  if (status >= 500) {
    recordRouteError({ workspaceId: workspaceId ?? null, operation: "execution", errorCode: error, error: detail });
  }
  return Response.json({ ok: false, error }, { status });
}

export const POST = withAuth<SynthesisRunsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  // Body is optional — a plain POST with no body (or empty body) is a valid,
  // pre-existing call shape (e.g. the desktop "start synthesis" retrigger).
  let body: SynthesisRunsBody = {};
  const rawBody = await req.text();
  if (rawBody) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return errorResponse("invalid_json", 400);
    }
    if (!isSynthesisRunsBody(parsed)) return errorResponse("invalid_body", 400);
    body = parsed;
  }

  const sourceItemIds = await getReadySourceItemIds(req.params.id, serviceClient);
  if (sourceItemIds.length === 0) {
    return Response.json({ ok: false, reason: "no_ready_items" });
  }

  try {
    const result = await launchSynthesisRun({
      workspaceId: req.params.id,
      triggerType: "manual",
      sourceItemIds,
      config: loadSandboxDeploymentConfig(),
      dimensions: body.dimensions,
    });
    return Response.json({ ok: true, runId: result.runId, machineId: result.machineId });
  } catch (err) {
    if (err instanceof WorkspaceRunAlreadyActiveError) {
      return errorResponse("run_already_active", 409, err);
    }
    if (err instanceof RunNotAllowedError) {
      return errorResponse("run_not_allowed", 403, err);
    }
    // launchSynthesisRun owns stage-aware recording; keep this boundary from
    // creating a duplicate row while preserving the exact response shape.
    return Response.json({ ok: false, error: "launch_failed" }, { status: 500 });
  }
});

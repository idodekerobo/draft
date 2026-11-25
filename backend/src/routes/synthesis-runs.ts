import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { loadSandboxDeploymentConfig } from "../metaharness/sandbox";
import { getPendingSynthesisSourceItemIds } from "../routines/built-in/synthesis/get-pending-source-items";
import { launchSynthesisRun } from "../routines/built-in/synthesis/orchestrate-run";
import { RunNotAllowedError } from "../routines/built-in/synthesis/check-run-allowed";
import { WorkspaceRunAlreadyActiveError } from "../routines/built-in/synthesis/prepare-run";
import type { DimensionHint } from "../routines/built-in/synthesis/types";
import { recordRouteError } from "../errors/route-error";
import { listActivity, parseCursor } from "../activity/service";

type SynthesisRunsRequest = Bun.BunRequest<"/workspaces/:id/synthesis-runs">;

export const GET = withAuth<SynthesisRunsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const before = parseCursor(new URL(req.url).searchParams.get("before"));
  if (before === "invalid") return Response.json({ error: "invalid_cursor" }, { status: 400 });
  try {
    return Response.json(await listActivity(serviceClient, req.params.id, before, caller.userId, { mine: new URL(req.url).searchParams.get("mine") === "1" }));
  } catch (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "read", errorCode: "synthesis_runs_read_failed", error });
    return Response.json({ error: "synthesis_runs_read_failed" }, { status: 500 });
  }
});

interface SynthesisRunsBody {
  dimensions?: DimensionHint[];
  // Explicit manual reprocessing: re-includes sources whose exact
  // (version, content_hash) a prior successful run already consumed.
  reprocess?: boolean;
}

function isDimensionHint(value: unknown): value is DimensionHint {
  if (!value || typeof value !== "object") return false;
  const hint = value as Partial<DimensionHint>;
  return typeof hint.dimensionName === "string" && typeof hint.dimensionDescription === "string";
}

function isSynthesisRunsBody(value: unknown): value is SynthesisRunsBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<SynthesisRunsBody>;
  return (body.dimensions === undefined || (Array.isArray(body.dimensions) && body.dimensions.every(isDimensionHint)))
    && (body.reprocess === undefined || typeof body.reprocess === "boolean");
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

  const sourceItemIds = await getPendingSynthesisSourceItemIds(req.params.id, serviceClient, {
    reprocess: body.reprocess ?? false,
  });
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
    return Response.json({ ok: true, runId: result.runId });
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

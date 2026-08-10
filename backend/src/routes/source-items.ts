import { createHash } from "node:crypto";
import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { upsertSourceConnection, upsertSourceItem } from "../ingestion/upsert-source-item";
import { loadSandboxDeploymentConfig } from "../sandbox";
import { RunNotAllowedError } from "../synthesis/check-run-allowed";
import { PILOT_RUN_BUNDLE_LIMITS } from "../synthesis/load-run-bundle";
import { launchSynthesisRun } from "../synthesis/orchestrate-run";
import { WorkspaceRunAlreadyActiveError } from "../synthesis/prepare-run";
import type { DimensionHint } from "../synthesis/types";

type SourceItemsRequest = Bun.BunRequest<"/workspaces/:id/source-items">;

interface UploadFile {
  path: string;
  content: string;
}

interface UploadBody {
  files: UploadFile[];
  /**
   * When true, immediately launch a synthesis run scoped to exactly the
   * items this request inserts — not every ready item in the workspace.
   * One request/response instead of the caller fetching inserted IDs and
   * making a second trigger call; also sidesteps ready items accumulated
   * from earlier, unrelated uploads pushing a later run over its bundle
   * byte cap.
   */
  triggerSynthesis?: boolean;
  /**
   * Context dimensions to guide a workspace's first synthesis run. Only
   * meaningful when triggerSynthesis is true and this is that workspace's
   * bootstrap run — see render-prompt.ts. Ignored on later runs.
   */
  dimensions?: DimensionHint[];
}

function isDimensionHint(value: unknown): value is DimensionHint {
  if (!value || typeof value !== "object") return false;
  const hint = value as Partial<DimensionHint>;
  return typeof hint.dimensionName === "string" && typeof hint.dimensionDescription === "string";
}

function errorResponse(error: string, status = 500, detail?: unknown): Response {
  if (status >= 500) {
    console.error(`source-items route: ${error}`, detail ?? "");
  }
  return Response.json({ ok: false, error }, { status });
}

function isUploadFile(value: unknown): value is UploadFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<UploadFile>;
  return typeof file.path === "string" && file.path.length > 0 && typeof file.content === "string";
}

function isUploadBody(value: unknown): value is UploadBody {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<UploadBody>;
  if (!Array.isArray(body.files) || !body.files.every(isUploadFile)) return false;
  if (body.triggerSynthesis !== undefined && typeof body.triggerSynthesis !== "boolean") return false;
  return body.dimensions === undefined || (Array.isArray(body.dimensions) && body.dimensions.every(isDimensionHint));
}

export const POST = withAuth<SourceItemsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("invalid_json", 400);
  }
  if (!isUploadBody(body)) return errorResponse("invalid_body", 400);

  const eligible: Array<{ path: string; content: string; bytes: number; contentHash: string }> = [];
  const skipped: string[] = [];
  for (const file of body.files) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > PILOT_RUN_BUNDLE_LIMITS.maxFileBytes) {
      skipped.push(file.path);
      continue;
    }
    eligible.push({
      path: file.path,
      content: file.content,
      bytes,
      contentHash: createHash("sha256").update(file.content, "utf8").digest("hex"),
    });
  }

  const totalBytes = eligible.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > PILOT_RUN_BUNDLE_LIMITS.maxTotalBytes) {
    return errorResponse("batch_too_large", 400);
  }
  if (eligible.length === 0) {
    return Response.json({ ok: true, inserted: 0, skipped });
  }

  let sourceConnection;
  try {
    sourceConnection = await upsertSourceConnection(serviceClient, {
      workspace_id: req.params.id,
      provider: "manual_upload",
      // Singleton per workspace — every upload batch upserts into the same row.
      connection_key: "manual-upload",
      status: "active",
      connected_by_user_id: caller.userId,
    });
  } catch (err) {
    return errorResponse("connection_upsert_failed", 500, err);
  }

  const insertedIds: string[] = [];
  const now = new Date().toISOString();
  for (const file of eligible) {
    try {
      const { item } = await upsertSourceItem(serviceClient, {
        workspace_id: req.params.id,
        source_connection_id: sourceConnection.id,
        item_type: "document",
        external_id: file.path,
        external_version: file.contentHash,
        occurred_at: now,
        content_markdown: file.content,
        content_hash: file.contentHash,
        lifecycle_status: "ready",
      });
      insertedIds.push(item.id);
    } catch (err) {
      console.error(`source-items route: failed to upsert ${file.path}`, err);
      skipped.push(file.path);
    }
  }

  if (!body.triggerSynthesis) {
    return Response.json({ ok: true, inserted: insertedIds.length, skipped });
  }

  if (insertedIds.length === 0) {
    return Response.json({ ok: true, inserted: 0, skipped, reason: "no_ready_items" });
  }

  try {
    const result = await launchSynthesisRun({
      workspaceId: req.params.id,
      triggerType: "manual",
      sourceItemIds: insertedIds,
      config: loadSandboxDeploymentConfig(),
      dimensions: body.dimensions,
    });
    return Response.json({
      ok: true,
      inserted: insertedIds.length,
      skipped,
      runId: result.runId,
      machineId: result.machineId,
    });
  } catch (err) {
    const synthesisError = err instanceof WorkspaceRunAlreadyActiveError
      ? "run_already_active"
      : err instanceof RunNotAllowedError
        ? "run_not_allowed"
        : "launch_failed";
    if (synthesisError === "launch_failed") {
      console.error("source-items route: triggerSynthesis launch failed", err);
    }
    // Upload itself succeeded — don't mask that behind ok:false just
    // because the chained launch failed afterward.
    return Response.json({ ok: true, inserted: insertedIds.length, skipped, synthesisError });
  }
});

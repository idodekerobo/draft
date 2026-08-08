import { createHash } from "node:crypto";
import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { upsertSourceConnection, upsertSourceItem } from "../ingestion/upsert-source-item";
import { PILOT_RUN_BUNDLE_LIMITS } from "../synthesis/load-run-bundle";

type SourceItemsRequest = Bun.BunRequest<"/workspaces/:id/source-items">;

interface UploadFile {
  path: string;
  content: string;
}

interface UploadBody {
  files: UploadFile[];
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
  return Array.isArray(body.files) && body.files.every(isUploadFile);
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

  let inserted = 0;
  const now = new Date().toISOString();
  for (const file of eligible) {
    try {
      await upsertSourceItem(serviceClient, {
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
      inserted += 1;
    } catch (err) {
      console.error(`source-items route: failed to upsert ${file.path}`, err);
      skipped.push(file.path);
    }
  }

  return Response.json({ ok: true, inserted, skipped });
});

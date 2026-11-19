import { randomUUID } from "node:crypto";
import { createSeedUpload } from "../cloud-sessions/snapshot-seed";
import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import { authorize, errorResponse } from "./sessions-live-shared";

type SeedUploadRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/seed-upload">;

/**
 * Makes the session id of a new cloud session that starts from a folder snapshot, and a signed upload link for the
 * snapshot under it. The start call passes the same id back, so the object sits under the session that uses it.
 */
export const SEED_UPLOAD = withAuth<SeedUploadRequest>(async (req, caller) => {
  const { id: workspaceId } = req.params;
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;

  const sessionId = randomUUID();
  try {
    const upload = await createSeedUpload(serviceClient, workspaceId, sessionId);
    return Response.json({ ok: true, sessionId, storageKey: upload.storageKey, signedUrl: upload.signedUrl });
  } catch (error) {
    return errorResponse("seed_upload_url_failed", 500, error, workspaceId, sessionId);
  }
});

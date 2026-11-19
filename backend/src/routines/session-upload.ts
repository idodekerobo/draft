import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunnerManifest } from "draft-core/run-manifest";
import { recordError } from "../errors/record-error";

/** The raw transcript bucket. Desktop raw uploads and routine runs share its folder convention. */
export const RAW_BUCKET = "session-raw";
export const RAW_SESSION_FILE = "root.jsonl.gz";
export const RAW_METADATA_FILE = "metadata.json";

/** The folder of a session's raw files: `<workspace>/<session>`, with a trailing slash in `raw_storage_path`. */
export const rawFolderOf = (workspaceId: string, sessionId: string): string => `${workspaceId}/${sessionId}`;

/**
 * Signed upload links for a routine run's session file and its metadata. Null when the links cannot be made, and
 * the run goes on without them: keeping the file never decides whether a run succeeds.
 */
export async function mintRoutineSessionUpload(
  client: SupabaseClient,
  workspaceId: string,
  sessionId: string,
): Promise<NonNullable<RunnerManifest["sessionUpload"]> | null> {
  const folder = rawFolderOf(workspaceId, sessionId);
  try {
    const bucket = client.storage.from(RAW_BUCKET);
    const [file, metadata] = await Promise.all([
      bucket.createSignedUploadUrl(`${folder}/${RAW_SESSION_FILE}`, { upsert: true }),
      bucket.createSignedUploadUrl(`${folder}/${RAW_METADATA_FILE}`, { upsert: true }),
    ]);
    if (file.error || !file.data) throw file.error ?? new Error("no upload URL returned for the session file");
    if (metadata.error || !metadata.data) throw metadata.error ?? new Error("no upload URL returned for the metadata");
    return { fileUrl: file.data.signedUrl, metadataUrl: metadata.data.signedUrl };
  } catch (error) {
    await recordError({
      client,
      workspaceId,
      sessionId,
      operation: "session",
      code: "session_upload_link_failed",
      message: "Making the upload links for a routine run's session file failed",
      error,
    });
    return null;
  }
}

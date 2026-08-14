import type { SupabaseClient } from "@supabase/supabase-js";

export const BUNDLE_STORAGE_BUCKET = "sandbox-bundles";
export const BUNDLE_SIGNED_URL_TTL_SECONDS = 600;

export interface UploadBundleInput {
  organizationId: string;
  workspaceId: string;
  runId: string;
  files: Record<string, string>;
}

export interface UploadedBundle {
  signedUrl: string;
  objectKey: string;
}

/**
 * Upload a run's assembled input bundle to private Supabase Storage and hand
 * back a short-TTL signed URL. Replaces embedding bundle content directly in
 * the Fly Machines create-request body, which has an undocumented size
 * ceiling well under what real user folders need.
 */
export async function uploadRunBundle(
  input: UploadBundleInput,
  client?: SupabaseClient,
): Promise<UploadedBundle> {
  const resolvedClient = client ?? (await import("../db/client")).serviceClient;
  const objectKey = `sandbox_uploads/${input.organizationId}/${input.workspaceId}/${input.runId}.json`;

  const { error: uploadError } = await resolvedClient.storage
    .from(BUNDLE_STORAGE_BUCKET)
    .upload(objectKey, JSON.stringify({ files: input.files }), {
      contentType: "application/json",
      upsert: true,
    });
  if (uploadError) {
    throw new Error(`bundle upload failed: ${uploadError.message}`);
  }

  const { data, error: signError } = await resolvedClient.storage
    .from(BUNDLE_STORAGE_BUCKET)
    .createSignedUrl(objectKey, BUNDLE_SIGNED_URL_TTL_SECONDS);
  if (signError || !data?.signedUrl) {
    throw new Error(
      `bundle signed URL generation failed: ${signError?.message ?? "no URL returned"}`,
    );
  }

  return { signedUrl: data.signedUrl, objectKey };
}

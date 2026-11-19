import type { SupabaseClient } from "@supabase/supabase-js";
import { recordError } from "../errors/record-error";

export const SNAPSHOT_BUCKET = "session-seeds";
export const SEED_FILE = "seed.tar.gz";
/** Long enough for the host to start and fetch the snapshot. The link is built again on every launch, never stored. */
export const SNAPSHOT_DOWNLOAD_TTL_SECONDS = 60 * 60;

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SNAPSHOT_KEY = /^([^/]+)\/([^/]+)\/seed\.tar\.gz$/;

/** The object key of a session's snapshot: `<workspace>/<session>/seed.tar.gz`. */
export function snapshotKeyFor(workspaceId: string, sessionId: string): string {
  return `${workspaceId}/${sessionId}/${SEED_FILE}`;
}

/** The session id in a snapshot key of this workspace, or null for any other key. */
export function sessionIdOfSnapshotKey(storageKey: string, workspaceId: string): string | null {
  const match = SNAPSHOT_KEY.exec(storageKey);
  if (!match || match[1] !== workspaceId || !SESSION_ID.test(match[2]!)) return null;
  return match[2]!;
}

/** The object key of a session's snapshot, read from its stored seed. Null when the session starts from something else. */
export function snapshotKeyOf(seed: unknown): string | null {
  const value = seed as { kind?: unknown; storageKey?: unknown } | null;
  return value?.kind === "snapshot" && typeof value.storageKey === "string" ? value.storageKey : null;
}

/** Where a snapshot lives. Production uses the service-role client; tests pass a fake. */
export interface SnapshotStore {
  exists(storageKey: string): Promise<boolean>;
  downloadUrl(storageKey: string, ttlSeconds: number): Promise<string>;
  /** Deletes the objects. A key that is already gone is not an error. */
  remove(storageKeys: string[]): Promise<void>;
}

export function storageSnapshotStore(client: SupabaseClient): SnapshotStore {
  return {
    async exists(storageKey) {
      const folder = storageKey.slice(0, storageKey.lastIndexOf("/"));
      const { data, error } = await client.storage.from(SNAPSHOT_BUCKET).list(folder);
      if (error) throw error;
      return (data ?? []).some((object) => object.name === SEED_FILE);
    },
    async downloadUrl(storageKey, ttlSeconds) {
      const { data, error } = await client.storage.from(SNAPSHOT_BUCKET).createSignedUrl(storageKey, ttlSeconds);
      if (error || !data?.signedUrl) throw new Error(`snapshot download link failed: ${error?.message ?? "no URL returned"}`);
      return data.signedUrl;
    },
    async remove(storageKeys) {
      if (storageKeys.length === 0) return;
      const { error } = await client.storage.from(SNAPSHOT_BUCKET).remove(storageKeys);
      if (error) throw error;
    },
  };
}

/**
 * Deletes a session's snapshot once nothing can start from it again. A failure is recorded and does not stop the
 * caller: the reconcile sweep removes snapshots of ended sessions, so it tries again.
 */
export async function discardSnapshot(
  snapshots: SnapshotStore,
  storageKey: string,
  ref: { client: SupabaseClient; workspaceId: string; sessionId: string },
): Promise<void> {
  try {
    await snapshots.remove([storageKey]);
  } catch (error) {
    await recordError({ client: ref.client, workspaceId: ref.workspaceId, sessionId: ref.sessionId, operation: "session", code: "snapshot_remove_failed", message: "Deleting the folder snapshot of a cloud session failed", error });
  }
}

/** A signed upload link for a snapshot under this session's key. The desktop PUTs the archive to it. */
export async function createSeedUpload(client: SupabaseClient, workspaceId: string, sessionId: string): Promise<{ storageKey: string; signedUrl: string }> {
  const storageKey = snapshotKeyFor(workspaceId, sessionId);
  const { data, error } = await client.storage.from(SNAPSHOT_BUCKET).createSignedUploadUrl(storageKey, { upsert: true });
  if (error || !data) throw new Error(`snapshot upload link failed: ${error?.message ?? "no URL returned"}`);
  return { storageKey, signedUrl: data.signedUrl };
}

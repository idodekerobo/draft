import type { SupabaseClient } from "@supabase/supabase-js";
import { codexCredentialRules } from "draft-core/harnesses/codex/credential";
import {
  acquireLease,
  credentialStatus,
  releaseLease,
  releaseLeaseForRun,
  resolveCredential,
  saveCredential,
  saveRefreshed,
  updateCredentialSecret,
} from "./harness-credential";

export const CODEX_CREDENTIAL_PROVIDER = codexCredentialRules.provider;

/** The status of the workspace's Codex login for routines, or null when it has none. */
export const codexCredentialStatus = (client: SupabaseClient, workspaceId: string): Promise<string | null> =>
  credentialStatus(client, workspaceId, codexCredentialRules);

/** Saves a new login for the workspace, replacing an earlier one. Returns the credential id. */
export const saveCodexCredential = (client: SupabaseClient, workspaceId: string, authJson: string, userId: string): Promise<string> =>
  saveCredential(client, workspaceId, codexCredentialRules, authJson, userId);

/** Reads the workspace's login. Throws a `CredentialError` when it is missing, revoked or expired. */
export async function resolveCodexCredential(client: SupabaseClient, workspaceId: string): Promise<{ credentialId: string; authJson: string }> {
  const { credentialId, secret } = await resolveCredential(client, workspaceId, codexCredentialRules);
  return { credentialId, authJson: secret };
}

/** Ends this run's lease on the workspace's login. Does nothing when the workspace has no login or the run does not hold the lease. */
export const releaseCodexLeaseForRun = (client: SupabaseClient, workspaceId: string, runId: string): Promise<void> =>
  releaseLeaseForRun(client, workspaceId, codexCredentialRules, runId);

/** Keeps the login a run sent back when Codex refreshed it. A file that is unreadable or unchanged is ignored. */
export const saveRefreshedCodexLogin = (client: SupabaseClient, workspaceId: string, sentBack: unknown): Promise<boolean> =>
  saveRefreshed(client, workspaceId, codexCredentialRules, sentBack);

/** Writes back a login that Codex refreshed during a run. */
export const updateCodexCredential = updateCredentialSecret;

/** True when this run now holds the login's lease. False when another run holds it. */
export const acquireCodexLease = (client: SupabaseClient, credentialId: string, workspaceId: string, runId: string): Promise<boolean> =>
  acquireLease(client, codexCredentialRules, credentialId, workspaceId, runId);

export const releaseCodexLease = releaseLease;

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { claudeCredentialRules } from "../cloud-sessions/claude-credential";
import { CredentialError } from "../credentials/crypto";
import { credentialStatus, resolveModelCredential } from "../credentials/harness-credential";

const ANTHROPIC = "anthropic";

/**
 * Gives pi the workspace's Claude login. The secret is read from the resolver on every call and never kept,
 * so a revoke or a re-save takes effect at once and nothing secret reaches pi's state or checkpoints.
 * A missing login reads as "not configured". A revoked, expired or unreadable one rejects so pi reports an auth failure.
 */
export function workspaceCredentialStore(client: SupabaseClient, workspaceId: string): CredentialStore {
  const read = async (providerId: string): Promise<Credential | undefined> => {
    if (providerId !== ANTHROPIC) return undefined;
    try {
      return { type: "api_key", key: (await resolveModelCredential(client, workspaceId)).secret };
    } catch (error) {
      if (error instanceof CredentialError && error.reason === "missing") return undefined;
      throw error;
    }
  };
  return {
    read,
    async list(): Promise<readonly CredentialInfo[]> {
      return (await credentialStatus(client, workspaceId, claudeCredentialRules)) ? [{ providerId: ANTHROPIC, type: "api_key" }] : [];
    },
    // The setup token does not rotate, so pi has nothing to write back. Draft owns saving and revoking it.
    async modify(providerId, fn) {
      const current = await read(providerId);
      await fn(current);
      return current;
    },
    async delete() {},
  };
}

/** The models a person can pick for Home on a lab: the lab's own, without the dated copies of an alias. */
export function homeModelCatalog(providerId: string = ANTHROPIC): Array<{ id: string; name: string }> {
  return builtinModels()
    .getModels(providerId)
    .filter((model) => !/-\d{8}$/.test(model.id))
    .map((model) => ({ id: model.id, name: model.name ?? model.id }));
}

/** Whether Home can run on this model id. */
export const isHomeModel = (id: string, providerId: string = ANTHROPIC): boolean => homeModelCatalog(providerId).some((model) => model.id === id);

/** pi's model catalog, authenticated with the workspace's Claude login. */
export const homeModels = (client: SupabaseClient, workspaceId: string) => builtinModels({ credentials: workspaceCredentialStore(client, workspaceId) });

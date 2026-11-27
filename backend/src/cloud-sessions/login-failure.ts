import type { SupabaseClient } from "@supabase/supabase-js";
import { claudeCredentialRules } from "./claude-credential";
import type { IncomingLine } from "draft-core/harnesses/claude/live-lines";
import { recordError } from "../errors/record-error";
import { notifyCredentialAttention } from "../notify/product/credential-attention";

/**
 * True when a batch of Claude transcript lines holds Claude Code's own "login failed" message. Claude writes it as a
 * synthetic assistant message with `error: "authentication_failed"`, so text a person or the model merely wrote about
 * logging in never counts.
 */
export function claudeLoginFailed(lines: readonly IncomingLine[]): boolean {
  for (const line of lines) {
    if (!("raw" in line) || typeof line.raw !== "string" || !line.raw.includes("authentication_failed")) continue;
    try {
      const entry = JSON.parse(line.raw) as { type?: unknown; isApiErrorMessage?: unknown; error?: unknown };
      if (entry.type === "assistant" && entry.isApiErrorMessage === true && entry.error === "authentication_failed") return true;
    } catch {
      // A line that is not JSON is not this message.
    }
  }
  return false;
}

/**
 * Tells whoever saved the workspace's Claude login that it stopped working in a running cloud session. The notice is keyed to
 * the login, so repeated failures send one. Never throws: the lines are already being stored.
 */
export async function reportCloudSessionLoginFailure(client: SupabaseClient, workspaceId: string, sessionId: string): Promise<void> {
  try {
    const { data, error } = await client.from("credentials").select("id").eq("workspace_id", workspaceId).eq("provider", claudeCredentialRules.provider).eq("status", "active").maybeSingle();
    if (error) throw error;
    const credentialId = (data as { id: string } | null)?.id;
    if (!credentialId) return;
    const { defaultChannels } = await import("../notify/delivery/send");
    await notifyCredentialAttention(client, defaultChannels(client), workspaceId, credentialId);
  } catch (cause) {
    await recordError({ client, workspaceId, sessionId, operation: "delivery", code: "product_notification_failed", message: "Login notice could not be recorded", error: cause });
  }
}

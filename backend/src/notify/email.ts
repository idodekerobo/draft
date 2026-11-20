import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelSendResult, NotifyMessage } from "draft-core/notify";
import { resendSettings } from "../config";
import type { PersonIdentityRow } from "../types/tables";
import { EMAIL_SENDERS } from "./constants";
import { renderEmail } from "./email-render";
import { sendResendEmail, type ResendDeps } from "./resend";
import type { NotifyChannel, ReachablePerson } from "./types";

export interface EmailChannelDeps extends ResendDeps {
  apiKey?: () => string | undefined;
}

const TRUSTED = ["confirmed", "from_connection"];

/** Resend remembers keys across the whole account, so the key is tied to the workspace and person, then hashed to a fixed length. */
export const providerIdempotencyKey = (person: ReachablePerson, callerKey: string) =>
  createHash("sha256").update(`${person.workspaceId}:${person.id}:${callerKey}`).digest("hex");

/** The person's verified email address, or null. The address comes from the checked person, never from the caller. */
export async function verifiedEmail(client: SupabaseClient, person: ReachablePerson): Promise<string | null> {
  const { data, error } = await client
    .from("person_identities")
    .select("external_id, status")
    .eq("workspace_id", person.workspaceId)
    .eq("person_id", person.id)
    .eq("provider", "email");
  if (error) throw error;
  const trusted = ((data ?? []) as Array<Pick<PersonIdentityRow, "external_id" | "status">>).find((identity) => TRUSTED.includes(identity.status));
  return trusted?.external_id ?? null;
}

/**
 * Emails a person at their verified address from the workspace-wide sender. `sent` means Resend accepted the email,
 * not that it was delivered. A provider error throws, so sendNotification logs it and reports provider_error.
 */
export function emailChannel(client: SupabaseClient, deps: EmailChannelDeps = {}): NotifyChannel {
  const apiKey = deps.apiKey ?? (() => resendSettings().apiKey);

  return {
    id: "email",
    canReach: async (person) => Boolean(apiKey()) && (await verifiedEmail(client, person)) !== null,
    async send(person, message: NotifyMessage): Promise<ChannelSendResult> {
      const key = apiKey();
      const to = key ? await verifiedEmail(client, person) : null;
      if (!key || !to) return { channel: "email", status: "failed", code: "not_reachable" };

      const rendered = renderEmail({ subject: message.subject, text: message.link ? `${message.text ?? ""}\n${message.link}` : message.text, html: message.html, footer: message.attribution });
      if (!rendered.ok) throw new Error(`email_content_invalid: ${rendered.code}`);

      await sendResendEmail(key, { from: EMAIL_SENDERS.notification, to: [to], ...rendered.email }, providerIdempotencyKey(person, message.idempotencyKey ?? randomUUID()), deps);
      return { channel: "email", status: "sent" };
    },
  };
}

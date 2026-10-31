import { recordError } from "../errors/record-error";
import { MetaSendError, sendMetaEvent, type MetaEventInput } from "../meta/capi";
import { readMetaSettings, type MetaSettings } from "../meta/settings";

export type Attribution = Record<string, Record<string, string>> | null;

export interface LeadSignup {
  signupId: string;
  email: string;
  eventId: string;
  source: string;
  attribution: Attribution;
  client: { ip?: string; userAgent?: string; sourceUrl?: string };
}

export interface LeadDeps {
  settings: MetaSettings | null;
  send: (event: MetaEventInput, settings: MetaSettings) => Promise<void>;
  logError: typeof recordError;
}

export type LeadResult = "sent" | "skipped_unconfigured" | "skipped_opt_out" | "failed";

function touchValue(attribution: Attribution, key: string): string | undefined {
  return attribution?.last?.[key] ?? attribution?.first?.[key];
}

// Visitors who send Global Privacy Control never load the pixel, so they get no server event either.
export function hasOptedOut(attribution: Attribution): boolean {
  return attribution?.last?.gpc === "1" || attribution?.first?.gpc === "1";
}

export function metaIdentifiers(attribution: Attribution) {
  return { fbp: touchValue(attribution, "fbp"), fbc: touchValue(attribution, "fbc") };
}

export async function sendLeadEvent(
  signup: LeadSignup,
  deps: LeadDeps = { settings: readMetaSettings(), send: sendMetaEvent, logError: recordError },
): Promise<LeadResult> {
  if (!deps.settings) return "skipped_unconfigured";
  if (hasOptedOut(signup.attribution)) return "skipped_opt_out";

  try {
    await deps.send(
      {
        eventName: "Lead",
        eventId: signup.eventId,
        email: signup.email,
        externalId: signup.signupId,
        sourceUrl: signup.client.sourceUrl,
        clientIp: signup.client.ip,
        userAgent: signup.client.userAgent,
        contentName: signup.source,
        ...metaIdentifiers(signup.attribution),
      },
      deps.settings,
    );
    return "sent";
  } catch (error) {
    const status = error instanceof MetaSendError ? error.status : null;
    const metaCode = error instanceof MetaSendError ? error.metaCode : null;
    await deps.logError({
      workspaceId: null,
      allowUnattributed: true,
      operation: "execution",
      message: "Meta Lead event send failed",
      error,
      detail: { signup_id: signup.signupId, event_id: signup.eventId, status, meta_code: metaCode },
    });
    return "failed";
  }
}

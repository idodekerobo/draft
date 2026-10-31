import { recordError } from "../errors/record-error";
import { MetaSendError, sendMetaEvent, type MetaEventInput, type MetaEventName } from "../meta/capi";
import { readMetaSettings, type MetaSettings } from "../meta/settings";

export type Attribution = Record<string, Record<string, string>> | null;

export interface SignupEvent {
  signupId: string;
  email: string;
  eventId: string;
  source: string;
  attribution: Attribution;
  client: { ip?: string; userAgent?: string; sourceUrl?: string };
  firstName?: string;
  lastName?: string;
  // Take precedence over the ids stored in attribution.
  fbp?: string;
  fbc?: string;
  optedOut?: boolean;
}

export interface EventDeps {
  settings: MetaSettings | null;
  send: (event: MetaEventInput, settings: MetaSettings) => Promise<void>;
  logError: typeof recordError;
}

export type EventResult = "sent" | "skipped_unconfigured" | "skipped_opt_out" | "failed";

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

export function defaultEventDeps(): EventDeps {
  return { settings: readMetaSettings(), send: sendMetaEvent, logError: recordError };
}

async function sendSignupEvent(eventName: MetaEventName, signup: SignupEvent, deps: EventDeps): Promise<EventResult> {
  if (!deps.settings) return "skipped_unconfigured";
  if (signup.optedOut || hasOptedOut(signup.attribution)) return "skipped_opt_out";

  const stored = metaIdentifiers(signup.attribution);
  try {
    await deps.send(
      {
        eventName,
        eventId: signup.eventId,
        email: signup.email,
        externalId: signup.signupId,
        sourceUrl: signup.client.sourceUrl,
        clientIp: signup.client.ip,
        userAgent: signup.client.userAgent,
        firstName: signup.firstName,
        lastName: signup.lastName,
        contentName: signup.source,
        fbp: signup.fbp ?? stored.fbp,
        fbc: signup.fbc ?? stored.fbc,
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
      message: `Meta ${eventName} event send failed`,
      error,
      detail: { signup_id: signup.signupId, event_id: signup.eventId, status, meta_code: metaCode },
    });
    return "failed";
  }
}

export function sendLeadEvent(signup: SignupEvent, deps: EventDeps = defaultEventDeps()): Promise<EventResult> {
  return sendSignupEvent("Lead", signup, deps);
}

export function sendScheduleEvent(signup: SignupEvent, deps: EventDeps = defaultEventDeps()): Promise<EventResult> {
  return sendSignupEvent("Schedule", signup, deps);
}

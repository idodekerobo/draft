import { hashForMeta } from "./hash";
import type { MetaSettings } from "./settings";

// TODO: check Meta's current Graph API version when this is deployed.
const GRAPH_VERSION = "v23.0";
const REQUEST_TIMEOUT_MS = 5000;

export type MetaEventName = "Lead" | "Schedule";

export interface MetaEventInput {
  eventName: MetaEventName;
  eventId: string;
  email: string;
  externalId: string;
  sourceUrl?: string;
  fbp?: string;
  fbc?: string;
  clientIp?: string;
  userAgent?: string;
  firstName?: string;
  lastName?: string;
  contentName?: string;
}

export class MetaSendError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly metaCode: number | null,
  ) {
    super(message);
  }
}

export function buildMetaRequest(event: MetaEventInput, settings: MetaSettings, nowMs: number = Date.now()) {
  const userData: Record<string, unknown> = {
    em: [hashForMeta(event.email)],
    external_id: [hashForMeta(event.externalId)],
  };
  if (event.fbp) userData.fbp = event.fbp;
  if (event.fbc) userData.fbc = event.fbc;
  if (event.clientIp) userData.client_ip_address = event.clientIp;
  if (event.userAgent) userData.client_user_agent = event.userAgent;
  if (event.firstName) userData.fn = [hashForMeta(event.firstName)];
  if (event.lastName) userData.ln = [hashForMeta(event.lastName)];

  const data: Record<string, unknown> = {
    event_name: event.eventName,
    event_time: Math.floor(nowMs / 1000),
    event_id: event.eventId,
    action_source: "website",
    user_data: userData,
  };
  if (event.sourceUrl) data.event_source_url = event.sourceUrl;
  if (event.contentName) data.custom_data = { content_name: event.contentName };

  return {
    url: `https://graph.facebook.com/${GRAPH_VERSION}/${settings.pixelId}/events`,
    body: {
      data: [data],
      access_token: settings.accessToken,
      ...(settings.testEventCode ? { test_event_code: settings.testEventCode } : {}),
    },
  };
}

export async function sendMetaEvent(
  event: MetaEventInput,
  settings: MetaSettings,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const { url, body } = buildMetaRequest(event, settings);
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MetaSendError(`Meta request failed: ${error instanceof Error ? error.name : "unknown"}`, null, null);
  }
  if (response.ok) return;
  const payload = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
  const metaCode = typeof payload?.error?.code === "number" ? payload.error.code : null;
  throw new MetaSendError(`Meta responded with status ${response.status}`, response.status, metaCode);
}

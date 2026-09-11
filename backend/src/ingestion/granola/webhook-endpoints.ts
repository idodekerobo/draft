const GRANOLA_API_BASE_URL = "https://public-api.granola.ai/v1";

export type GranolaProviderErrorCode =
  | "granola_webhook_create_failed"
  | "granola_webhook_delete_failed"
  | "granola_account_lookup_failed";

export class GranolaProviderError extends Error {
  constructor(public readonly code: GranolaProviderErrorCode) {
    super(code);
    this.name = "GranolaProviderError";
  }
}

const HANDLED_EVENTS = ["note.generated", "note.edited", "note.access_granted"];

export interface GranolaWebhookEndpoint {
  id: string;
  url: string;
  signingSecret: string;
  createdBy: { name: string | null; email: string | null } | null;
}

/** Registers a Draft webhook endpoint with Granola using the caller's API key. */
export async function createGranolaWebhookEndpoint(
  apiToken: string,
  url: string,
  scope: "personal" | "public",
  fetchFn: typeof fetch = fetch,
): Promise<GranolaWebhookEndpoint> {
  const response = await fetchFn(`${GRANOLA_API_BASE_URL}/webhook-endpoints`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, scopes: [scope], events: HANDLED_EVENTS }),
  });
  if (!response.ok) throw new GranolaProviderError("granola_webhook_create_failed");

  const payload = await response.json() as {
    id?: unknown;
    url?: unknown;
    signing_secret?: unknown;
    created_by?: { name?: unknown; email?: unknown } | null;
  };
  if (
    typeof payload.id !== "string" ||
    typeof payload.url !== "string" ||
    typeof payload.signing_secret !== "string"
  ) {
    throw new GranolaProviderError("granola_webhook_create_failed");
  }

  return {
    id: payload.id,
    url: payload.url,
    signingSecret: payload.signing_secret,
    createdBy: payload.created_by
      ? {
          name: typeof payload.created_by.name === "string" ? payload.created_by.name : null,
          email: typeof payload.created_by.email === "string" ? payload.created_by.email : null,
        }
      : null,
  };
}

/** Removes a Granola webhook endpoint. A 404 (already gone) is not an error. */
export async function deleteGranolaWebhookEndpoint(
  apiToken: string,
  webhookEndpointId: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchFn(`${GRANOLA_API_BASE_URL}/webhook-endpoints/${webhookEndpointId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new GranolaProviderError("granola_webhook_delete_failed");
  }
}

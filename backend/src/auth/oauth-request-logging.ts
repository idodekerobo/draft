import { createHash } from "node:crypto";
import { recordRouteError } from "../errors/route-error";

const grants = new Set(["authorization_code", "refresh_token", "client_credentials", "urn:ietf:params:oauth:grant-type:jwt-bearer"]);
const errors = new Set(["invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "access_denied", "invalid_target", "server_error", "temporarily_unavailable", "login_required", "consent_required"]);

async function boundedText(message: Request | Response): Promise<string | null> {
  const reader = message.clone().body?.getReader();
  if (!reader) return "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const next = await reader.read();
          if (next.done) return new TextDecoder().decode(Buffer.concat(chunks));
          length += next.value.byteLength;
          if (length > 8192) return null;
          chunks.push(next.value);
        }
      })(),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 100); }),
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

export function createLoggedOAuthHandler(
  handle: (request: Request) => Promise<Response>,
  record: (detail: Record<string, unknown>) => void = (detail) => {
    if (Number(detail.status) >= 400) recordRouteError({ workspaceId: null, allowUnattributed: true, operation: "auth", errorCode: "oauth_request_rejected", detail });
    else console.info(JSON.stringify({ source: "oauth", ...detail }));
  },
) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path !== "/api/auth/oauth2/token" && path !== "/api/auth/oauth2/authorize") return handle(request);
    const started = performance.now();
    const params = new URL(request.url).searchParams;
    const form = request.method === "POST" && request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")
      ? new URLSearchParams(await boundedText(request) ?? "") : params;
    const client = form.get("client_id");
    const grant = form.get("grant_type");
    const detail = {
      request_id: crypto.randomUUID(), path, method: request.method,
      ...(client ? { client_hash: createHash("sha256").update(client).digest("hex") } : {}),
      ...(grant && grants.has(grant) ? { grant_type: grant } : {}),
    };
    try {
      const response = await handle(request);
      let error: unknown;
      if (response.status >= 400 && response.headers.get("content-type")?.includes("application/json")) {
        try { error = JSON.parse(await boundedText(response) ?? "null")?.error; } catch { /* Invalid JSON carries no safe error code. */ }
      }
      record({ ...detail, status: response.status, duration_ms: Math.round(performance.now() - started),
        ...(typeof error === "string" && errors.has(error) ? { oauth_error: error } : {}) });
      return response;
    } catch (error) {
      record({ ...detail, status: 500, duration_ms: Math.round(performance.now() - started), oauth_error: "server_error" });
      throw error;
    }
  };
}

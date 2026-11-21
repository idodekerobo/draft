import { redactString } from "../errors/record-error";
import { recordRouteError } from "../errors/route-error";

export interface McpRequestContext {
  stage: "token_verification" | "missing_subject" | "mcp_handling";
  userId?: string;
  clientId?: string;
  scopes?: string[];
}

type RouteRecorder = typeof recordRouteError;

async function responseSummary(response: Response, safeText: (value: string) => string): Promise<Record<string, unknown>> {
  if (!response.headers.get("content-type")?.includes("application/json")) return {};
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return {};
    const bodyReader = reader;
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await bodyReader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 8192) return { response_summary: "too_large" };
        chunks.push(value);
      }
      const body = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
      const error = body?.error;
      const reasons: Record<string, string> = {
        "missing authorization header": "missing_authorization",
        "authorization scheme must be Bearer or DPoP": "unsupported_scheme",
        "token expired": "expired",
        "invalid access token": "invalid_access_token",
        "no token payload": "missing_payload",
        "access token scope claim is invalid": "invalid_scope_claim",
      };
      const reason = typeof error?.message === "string" && Object.hasOwn(reasons, error.message) ? reasons[error.message] : undefined;
      return {
        ...(reason ? { rejection_reason: reason } : {}),
        ...(typeof error === "string" ? { response_error: safeText(error) } : {}),
        ...(typeof error?.code === "number" ? { response_error_code: error.code } : {}),
        ...(typeof error?.message === "string" ? { response_error_message: safeText(error.message) } : {}),
      };
    };
    return await Promise.race([
      read(),
      new Promise<Record<string, unknown>>((resolve) => {
        timer = setTimeout(() => resolve({ response_summary: "timeout" }), 100);
      }),
    ]);
  } catch {
    return { response_summary: "unavailable" };
  } finally {
    clearTimeout(timer);
    // A cloned stream's cancellation can wait for the client to consume its branch.
    void reader?.cancel().catch(() => {});
  }
}

export function createLoggedMcpHandler(
  handle: (request: Request, context: McpRequestContext) => Promise<Response>,
  expected: { issuer: string; resource: string; requiredScopes: string[] },
  record: RouteRecorder = recordRouteError,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const started = performance.now();
    const requestId = crypto.randomUUID();
    const context: McpRequestContext = { stage: "token_verification" };
    const authorization = request.headers.get("authorization");
    const parts = authorization?.trim().split(/\s+/) ?? [];
    const credential = parts.slice(1).join(" ");
    const safeText = (value: string) => redactString(
      (credential ? value.replaceAll(credential, "[REDACTED]") : value)
        .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]"),
    ).slice(0, 512);
    const detail = () => ({
      request_id: requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      duration_ms: Math.round(performance.now() - started),
      stage: context.stage,
      authorization_present: authorization !== null,
      authorization_scheme: !authorization ? "none" : /^Bearer$/i.test(parts[0] ?? "") ? "Bearer" : /^DPoP$/i.test(parts[0] ?? "") ? "DPoP" : "other",
      credential_present: credential.length > 0,
      user_agent: safeText(request.headers.get("user-agent") ?? ""),
      mcp_protocol_version: safeText(request.headers.get("mcp-protocol-version") ?? ""),
      expected_issuer: expected.issuer,
      expected_resource: expected.resource,
      required_scopes: expected.requiredScopes,
      ...(context.userId ? { verified_user_id: safeText(context.userId) } : {}),
      ...(context.clientId ? { verified_client_id: safeText(context.clientId) } : {}),
      ...(context.scopes ? { verified_scopes: context.scopes.slice(0, 32).map(safeText) } : {}),
    });
    try {
      const response = await handle(request, context);
      if (response.status >= 400) {
        const challenge = response.headers.get("www-authenticate")?.slice(0, 4096);
        const challengeDetail: Record<string, string> = {};
        if (challenge) {
          challengeDetail.challenge_scheme = /^DPoP\b/i.test(challenge) ? "DPoP" : /^Bearer\b/i.test(challenge) ? "Bearer" : "other";
          for (const match of challenge.matchAll(/\b(error|error_description|scope|resource_metadata)="([^"\r\n]*)"/g)) {
            if (match[1] === "resource_metadata") {
              try {
                const url = new URL(match[2]!);
                challengeDetail.challenge_resource_metadata = safeText(`${url.origin}${url.pathname}`);
              } catch { /* Ignore malformed metadata URLs. */ }
            } else {
              challengeDetail[`challenge_${match[1]}`] = safeText(match[2]!);
            }
          }
        }
        record({
          workspaceId: null,
          allowUnattributed: true,
          operation: response.status === 401 || response.status === 403 ? "auth" : "read",
          errorCode: "mcp_request_rejected",
          detail: { ...detail(), status: response.status, ...challengeDetail, ...await responseSummary(response, safeText) },
        });
      }
      return response;
    } catch (error) {
      const loggedError = new Error(safeText(error instanceof Error ? error.message : String(error)));
      if (error instanceof Error) {
        loggedError.name = safeText(error.name);
        loggedError.stack = error.stack ? safeText(error.stack) : undefined;
        const code = (error as Error & { code?: unknown }).code;
        if (typeof code === "string") Object.assign(loggedError, { code: safeText(code) });
      }
      record({
        workspaceId: null,
        allowUnattributed: true,
        operation: context.stage === "mcp_handling" ? "read" : "auth",
        errorCode: "mcp_request_failed",
        error: loggedError,
        detail: detail(),
      });
      throw error;
    }
  };
}

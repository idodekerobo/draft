import { sanitizeMcpMessage } from 'draft-core/integrations/mcp-health';

export type SourceErrorCode =
  | "mcp_missing"
  | "mcp_auth"
  | "mcp_connect"
  | "mcp_rate_limited"
  | "mcp_tool_error";

export interface SourceUnavailableResult {
  kind: "source_unavailable";
  code: SourceErrorCode;
  message: string;
}

export class SourceUnavailableError extends Error {
  constructor(
    public readonly code: SourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

export const SOURCE_UNAVAILABLE_PREFIX = "DRAFT_SOURCE_UNAVAILABLE ";

export function parseSourceUnavailable(output: string): SourceUnavailableResult | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith(SOURCE_UNAVAILABLE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(SOURCE_UNAVAILABLE_PREFIX.length)) as Record<string, unknown>;
    const allowed = new Set<SourceErrorCode>([
      "mcp_missing", "mcp_auth", "mcp_connect", "mcp_rate_limited", "mcp_tool_error",
    ]);
    if (!allowed.has(parsed.code as SourceErrorCode) || typeof parsed.message !== "string") return null;
    return {
      kind: "source_unavailable",
      code: parsed.code as SourceErrorCode,
      message: sanitizeMcpMessage(parsed.message) || "The source could not be reached.",
    };
  } catch {
    return null;
  }
}

export const SOURCE_FAILURE_PROMPT = `If the required MCP tools are missing, unavailable, unauthenticated, rate-limited, or any required MCP call fails, do not return a maintainer outcome. Write exactly one line to the output file:
DRAFT_SOURCE_UNAVAILABLE {"code":"mcp_missing|mcp_auth|mcp_connect|mcp_rate_limited|mcp_tool_error","message":"short sanitized reason"}
Choose exactly one code and do not include credentials, tokens, raw tool output, YAML, or any other text.`;

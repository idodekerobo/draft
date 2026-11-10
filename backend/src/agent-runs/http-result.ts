import type { InvokeToolResult } from "./invoke-tool";

function statusFor(result: InvokeToolResult): number {
  switch (result.status) {
    case "ok":
    case "conflict":
      return 200;
    case "denied":
      return 403;
    case "invalid":
      return 400;
    case "error":
      return 500;
  }
}

/**
 * The answer every HTTP edge gives for a tool call: the result itself, `{ status, output | message | issues }`.
 * A person refused by the workspace check gets that check's own answer, so a non-member sees what they always saw.
 */
export function toHttpResponse(result: InvokeToolResult): Response {
  if (result.status === "denied" && result.detail) return Response.json(result.detail.body, { status: result.detail.status });
  return Response.json(result, { status: statusFor(result) });
}

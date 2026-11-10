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

/** The tool input from a request body: none means `{}`. A body that is not JSON is answered 400. */
export function parseToolArgs(bodyText: string): { ok: true; args: unknown } | { ok: false; response: Response } {
  if (!bodyText.trim()) return { ok: true, args: {} };
  try {
    return { ok: true, args: JSON.parse(bodyText) };
  } catch {
    return { ok: false, response: Response.json({ status: "invalid", issues: ["body is not valid JSON"] }, { status: 400 }) };
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

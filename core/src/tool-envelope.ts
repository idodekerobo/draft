/**
 * The answer to a tool call as it crosses the wire, from a run's tool endpoint and from a person's.
 * The backend writes it; the CLI, the web app and the desktop app read it with `decodeToolEnvelope`.
 *
 * `refused` is the tool's own "no": the call ran and the answer is that it cannot be done (no context yet, a name
 * that is taken). `denied` means the caller may not use the tool. `invalid` is input that does not fit.
 * `error` is a failure inside the tool.
 */
export type ToolEnvelope =
  | { status: "ok"; output: unknown }
  | { status: "conflict"; output: unknown }
  | { status: "refused"; code: string; message: string }
  | { status: "denied"; code: string; message: string }
  | { status: "invalid"; issues: string[] }
  | { status: "error"; message: string };

export type ToolFailureStatus = "refused" | "denied" | "invalid" | "error" | "malformed";

/** What a client does with an envelope: use the output, or report one failure with a stable code. */
export type ToolOutcome =
  | { ok: true; output: unknown; conflict: boolean }
  | { ok: false; status: ToolFailureStatus; code: string; message: string };

const text = (value: unknown, fallback: string): string => (typeof value === "string" && value.length > 0 ? value : fallback);

/** Reads a parsed JSON body. Anything that is not an envelope is `malformed`, never a throw. */
export function decodeToolEnvelope(value: unknown): ToolOutcome {
  if (typeof value !== "object" || value === null) return { ok: false, status: "malformed", code: "malformed_response", message: "The answer was not a tool result." };
  const body = value as Record<string, unknown>;

  switch (body.status) {
    case "ok":
      return { ok: true, output: body.output, conflict: false };
    case "conflict":
      return { ok: true, output: body.output, conflict: true };
    case "refused":
    case "denied":
      return { ok: false, status: body.status, code: text(body.code, body.status), message: text(body.message, text(body.code, body.status)) };
    case "invalid": {
      const issues = Array.isArray(body.issues) ? body.issues.filter((issue): issue is string => typeof issue === "string") : [];
      return { ok: false, status: "invalid", code: "invalid_input", message: issues.length > 0 ? issues.join("; ") : "The input did not fit the tool." };
    }
    case "error":
      return { ok: false, status: "error", code: "tool_error", message: text(body.message, "The tool failed.") };
  }
  // A person the workspace check refuses is answered with that check's own body: { error }.
  if (typeof body.error === "string") return { ok: false, status: "denied", code: body.error, message: body.error };
  return { ok: false, status: "malformed", code: "malformed_response", message: "The answer was not a tool result." };
}

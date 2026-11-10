import type { InvokeToolResult } from "./invoke-tool";

/** What an MCP client reads back from a tool call, as text. */
export function toMcpResult(result: InvokeToolResult) {
  switch (result.status) {
    case "ok":
      // A tool that already has text for the agent, such as a remote server's reply, sends it as it is.
      return { content: [{ type: "text" as const, text: typeof result.output === "string" ? result.output : JSON.stringify(result.output) }] };
    case "conflict":
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "conflict", ...(result.output as object) }) }] };
    case "refused":
      // The tool's own no. The code stays under `error`, as these tools always answered, and the call is flagged as failed.
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: result.code, message: result.message }) }] };
    case "denied":
      // A person refused by the access check has always seen the status, so that stays.
      return { isError: true, content: [{ type: "text" as const, text: result.detail ? `forbidden (${result.detail.status})` : result.message }] };
    case "invalid":
      return { isError: true, content: [{ type: "text" as const, text: `Invalid input: ${result.issues.join("; ")}` }] };
    case "error":
      return { isError: true, content: [{ type: "text" as const, text: result.message }] };
  }
}

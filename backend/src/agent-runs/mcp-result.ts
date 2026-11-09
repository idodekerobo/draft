import type { InvokeToolResult } from "./invoke-tool";

/** What an MCP client reads back from a tool call, as text. */
export function toMcpResult(result: InvokeToolResult) {
  switch (result.status) {
    case "ok":
      return { content: [{ type: "text" as const, text: JSON.stringify(result.output) }] };
    case "conflict":
      return { content: [{ type: "text" as const, text: JSON.stringify({ status: "conflict", ...(result.output as object) }) }] };
    case "denied":
      // A person refused by the access check has always seen the status, so that stays.
      return { isError: true, content: [{ type: "text" as const, text: result.detail ? `forbidden (${result.detail.status})` : result.message }] };
    case "invalid":
      return { isError: true, content: [{ type: "text" as const, text: `Invalid input: ${result.issues.join("; ")}` }] };
    case "error":
      return { isError: true, content: [{ type: "text" as const, text: result.message }] };
  }
}

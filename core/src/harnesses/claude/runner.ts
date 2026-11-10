import { classifyFailureChunk } from "../failure";
import type { RunnerManifest } from "../../run-manifest";
import type { FailureCategory, RunnerSide, StructuredResult } from "../types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ClaudeEnvelope {
  type: "result";
  result?: unknown;
  structured_output?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

export function classifyClaudeEnvelopeFailure(
  envelope: ClaudeEnvelope | null,
  current: FailureCategory = "none",
): FailureCategory {
  if (envelope?.is_error !== true || typeof envelope.result !== "string") return current;
  return classifyFailureChunk(envelope.result, current);
}

export function parseCompletedClaudeEnvelope(raw: string): ClaudeEnvelope | null {
  const candidates = [raw.trim(), ...raw.trim().split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        isObject(parsed) &&
        parsed.type === "result" &&
        (Object.prototype.hasOwnProperty.call(parsed, "result") ||
          Object.prototype.hasOwnProperty.call(parsed, "structured_output"))
      ) {
        return parsed as ClaudeEnvelope;
      }
    } catch {
      // Streaming output can contain non-JSON progress lines or partial JSON.
    }
  }
  return null;
}

export function parseResultPayload(value: unknown): unknown | null {
  if (isObject(value) || Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) || Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractStructuredOutput(envelope: ClaudeEnvelope | null): unknown | null {
  if (envelope?.is_error === true) return null;
  return parseResultPayload(envelope?.structured_output);
}

export function sanitizedClaudeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is required");
  const allowed: Record<string, string> = {
    HOME: "/home/agent",
    USER: "agent",
    LOGNAME: "agent",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: env.LANG || "C.UTF-8",
    CLAUDE_CODE_OAUTH_TOKEN: token,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (env.TZ) allowed.TZ = env.TZ;
  if (env.DRAFT_RUN_TOKEN) allowed.DRAFT_RUN_TOKEN = env.DRAFT_RUN_TOKEN;
  return allowed;
}

const CLAUDE_READ_ONLY_TOOLS = ["Read", "Glob", "Grep"];

/** Draft's tool server for a Claude Code run. The header reads the token from the environment. */
export function claudeMcpConfigJson(mcpUrl: string): string {
  return JSON.stringify({ mcpServers: { draft: { type: "http", url: mcpUrl, headers: { Authorization: "Bearer ${DRAFT_RUN_TOKEN}" } } } });
}

/** Claude Code's command. Reading is allowed on its own; any other built-in tool has to be named, or dontAsk refuses it. */
export function claudeArgs(manifest: RunnerManifest, prompt: string, schemaText: string | null): string[] {
  if (manifest.harness !== "claude") throw new Error("claudeArgs needs a Claude manifest");
  if (manifest.output.kind === "structured" && schemaText === null) throw new Error("structured output needs a schema");
  const { model } = manifest;
  const { native, draftMcpUrl } = manifest.tools;
  // Claude Code turns dots in tool names into underscores, so Draft's tools are allowed by server name.
  const allowed = [...(draftMcpUrl ? ["mcp__draft"] : []), ...native.filter((tool) => !CLAUDE_READ_ONLY_TOOLS.includes(tool))];
  return [
    "-p",
    prompt,
    ...(model ? ["--model", model] : []),
    "--tools",
    native.join(","),
    "--permission-mode",
    "dontAsk",
    ...(draftMcpUrl ? ["--mcp-config", claudeMcpConfigJson(draftMcpUrl), "--strict-mcp-config"] : []),
    ...(allowed.length > 0 ? ["--allowedTools", ...allowed] : []),
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(manifest.output.kind === "structured" ? ["--json-schema", schemaText!] : []),
  ];
}

// Every line of stream-json output is its own JSON message (system init,
// assistant turns, tool calls/results, and the final "result" envelope).
// Kept alongside parseCompletedClaudeEnvelope rather than replacing it --
// this returns the whole transcript, that one still finds just the
// terminal envelope for control flow.
export function parseStreamJsonTranscript(raw: string): unknown[] {
  const messages: unknown[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON progress/partial lines are expected in a streamed buffer.
    }
  }
  return messages;
}

export const claudeRunner: RunnerSide = {
  command: (manifest, prompt, schemaText, env) => ({
    argv: ["claude", ...claudeArgs(manifest, prompt, schemaText)],
    stdin: null,
    cwd: "/run",
    env: sanitizedClaudeEnv(env),
  }),
  prepare: () => undefined,
  logNames: { started: "claude_started", finished: "claude_finished" },
  startedFields: (manifest: RunnerManifest) => ({ tools: manifest.tools.native.join(","), permission_mode: "dontAsk" }),
  failureCodes: { error: "claude_error", exit: "claude_exit" },
  resultOfLine: (raw) => {
    if (!raw.includes('"type":"result"')) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed) && parsed.type === "result") return parsed as { is_error?: boolean; subtype?: string };
    } catch { /* a partial line is not the result */ }
    return null;
  },
  refreshedLogin: () => undefined,
  structured: {
    completed: (stdout) => parseCompletedClaudeEnvelope(stdout) as StructuredResult | null,
    payload: (result) => extractStructuredOutput(result as ClaudeEnvelope | null),
    failureOf: (result, current: FailureCategory) => classifyClaudeEnvelopeFailure(result as ClaudeEnvelope | null, current),
    transcript: parseStreamJsonTranscript,
  },
};

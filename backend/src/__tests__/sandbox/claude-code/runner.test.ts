import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildFailureDiagnostics,
  classifyClaudeEnvelopeFailure,
  classifyClaudeFailureChunk,
  extractStructuredOutput,
  claudeCommandArgs,
  parseCompletedClaudeEnvelope,
  parseResultPayload,
  readOutputSchema,
  parseTimeoutSeconds,
  sanitizedClaudeEnv,
  shouldRetryCallback,
} from "../../../sandbox/claude-code/runner";

test("Claude command is read-only, noninteractive, ephemeral, and schema-constrained", () => {
  const schema = '{"type":"object","required":["outcome"]}';
  expect(claudeCommandArgs("inspect the input", schema)).toEqual([
    "-p",
    "inspect the input",
    "--tools",
    "Read,Glob",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    schema,
  ]);
});

describe("Claude result detection", () => {
  test("accepts and extracts a structured-output-only result after progress output", () => {
    const raw = 'progress\n{"type":"result","is_error":false,"structured_output":{"outcome":"no_change"}}\n';
    const envelope = parseCompletedClaudeEnvelope(raw);
    expect(envelope?.type).toBe("result");
    expect(extractStructuredOutput(envelope)).toEqual({ outcome: "no_change" });
  });

  test("does not treat prose result as successful structured output", () => {
    const envelope = parseCompletedClaudeEnvelope(JSON.stringify({
      type: "result",
      is_error: false,
      result: '{"outcome":"legacy"}',
    }));
    expect(envelope).not.toBeNull();
    expect(extractStructuredOutput(envelope)).toBeNull();
  });

  test("rejects incomplete or non-result JSON", () => {
    expect(parseCompletedClaudeEnvelope('{"type":"assistant"}')).toBeNull();
    expect(parseCompletedClaudeEnvelope('{"type":"result"')).toBeNull();
    expect(parseResultPayload("plain text")).toBeNull();
  });
});

describe("output schema input", () => {
  test("reads a non-array JSON object beneath the input root", () => {
    const inputRoot = mkdtempSync(join(tmpdir(), "draft-schema-"));
    const schemaPath = join(inputRoot, "output-schema.json");
    writeFileSync(schemaPath, '{"type":"object","additionalProperties":false}\n');
    expect(readOutputSchema(schemaPath, inputRoot)).toBe(
      '{"type":"object","additionalProperties":false}',
    );
  });

  test("rejects arrays, invalid JSON, and paths outside the input root", () => {
    const inputRoot = mkdtempSync(join(tmpdir(), "draft-schema-"));
    const arrayPath = join(inputRoot, "array.json");
    const invalidPath = join(inputRoot, "invalid.json");
    const outsidePath = join(tmpdir(), `outside-schema-${process.pid}.json`);
    writeFileSync(arrayPath, "[]");
    writeFileSync(invalidPath, "not-json");
    writeFileSync(outsidePath, "{}");
    expect(() => readOutputSchema(arrayPath, inputRoot)).toThrow("JSON object");
    expect(() => readOutputSchema(invalidPath, inputRoot)).toThrow("valid JSON");
    expect(() => readOutputSchema(outsidePath, inputRoot)).toThrow("beneath /run/input");
  });
});

test("Claude receives only the allowlisted environment", () => {
  const env = sanitizedClaudeEnv({
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
    DRAFT_CALLBACK_TOKEN: "callback-secret",
    DRAFT_RUN_ID: "run-secret",
    TZ: "UTC",
  });
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
  expect(env.DRAFT_CALLBACK_TOKEN).toBeUndefined();
  expect(env.DRAFT_RUN_ID).toBeUndefined();
  expect(env.TZ).toBe("UTC");
});

test("timeout bounds and callback retry policy are conservative", () => {
  expect(parseTimeoutSeconds(undefined)).toBe(300);
  expect(parseTimeoutSeconds("90")).toBe(90);
  expect(() => parseTimeoutSeconds("0")).toThrow();
  expect(() => parseTimeoutSeconds("3601")).toThrow();
  expect(shouldRetryCallback(429)).toBe(true);
  expect(shouldRetryCallback(503)).toBe(true);
  expect(shouldRetryCallback(400)).toBe(false);
});

describe("safe Claude diagnostics", () => {
  test("classifies stderr using fixed categories without returning source text", () => {
    expect(classifyClaudeFailureChunk("OAuth token rejected: secret-value")).toBe("auth");
    expect(classifyClaudeFailureChunk("HTTP 429 from service")).toBe("rate_limit");
    expect(classifyClaudeFailureChunk("EACCES permission denied")).toBe("permission");
    expect(classifyClaudeFailureChunk("socket ECONNRESET")).toBe("network");
    expect(classifyClaudeFailureChunk("unexpected internal detail")).toBe("other");
    expect(classifyClaudeFailureChunk("")).toBe("none");
  });

  test("classifies an authentication failure carried only by an error envelope", () => {
    const envelope = parseCompletedClaudeEnvelope(JSON.stringify({
      type: "result",
      is_error: true,
      result: "Failed to authenticate with a sensitive provider response",
    }));
    expect(classifyClaudeEnvelopeFailure(envelope)).toBe("auth");
    expect(classifyClaudeEnvelopeFailure({
      type: "result",
      is_error: false,
      result: "Failed to authenticate",
    })).toBe("none");
    expect(classifyClaudeEnvelopeFailure({
      type: "result",
      is_error: true,
      result: { arbitrary: "Failed to authenticate" },
    })).toBe("none");
  });

  test("builds a fixed-code failure summary and returns null for valid payloads", () => {
    const base = {
      timedOut: false,
      overflow: false,
      envelopeFound: true,
      envelopeIsError: true,
      payloadValid: false,
      exitCode: 1,
      signal: null,
      failureCategory: "auth" as const,
    };
    expect(buildFailureDiagnostics(base)).toEqual({ ...base, failureCode: "claude_error" });
    expect(buildFailureDiagnostics({ ...base, timedOut: true })).toMatchObject({
      failureCode: "timeout",
    });
    expect(buildFailureDiagnostics({ ...base, payloadValid: true })).toBeNull();
  });
});

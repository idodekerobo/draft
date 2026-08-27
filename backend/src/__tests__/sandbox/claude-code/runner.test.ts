import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertWithinInputRoot,
  buildFailureDiagnostics,
  classifyClaudeEnvelopeFailure,
  classifyClaudeFailureChunk,
  extractStructuredOutput,
  claudeCommandArgs,
  fetchAndWriteBundle,
  parseBatchManifest,
  parseCompletedClaudeEnvelope,
  parseResultPayload,
  parseStreamJsonTranscript,
  readOutputSchema,
  parseTimeoutSeconds,
  recomputeBundleHash,
  sanitizedClaudeEnv,
  shouldRetryCallback,
} from "../../../sandbox/claude-code/runner";

test("Claude command is read-only, noninteractive, ephemeral, streamed, and schema-constrained", () => {
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
    "stream-json",
    "--verbose",
    "--json-schema",
    schema,
  ]);
});

describe("parseStreamJsonTranscript", () => {
  test("collects every valid JSON line into an array", () => {
    const raw = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":"looking at the bundle"}}',
      '{"type":"result","is_error":false,"structured_output":{"outcome":"no_change"}}',
    ].join("\n");
    expect(parseStreamJsonTranscript(raw)).toEqual([
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: "looking at the bundle" } },
      { type: "result", is_error: false, structured_output: { outcome: "no_change" } },
    ]);
  });

  test("skips blank lines and non-JSON noise without throwing", () => {
    const raw = '\n{"type":"system"}\n\nnot json\n  \n{"type":"result","is_error":true}\n';
    expect(parseStreamJsonTranscript(raw)).toEqual([{ type: "system" }, { type: "result", is_error: true }]);
  });

  test("returns an empty array for empty input", () => {
    expect(parseStreamJsonTranscript("")).toEqual([]);
    expect(parseStreamJsonTranscript("   \n  \n")).toEqual([]);
  });
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

describe("bundle path safety", () => {
  test("accepts a path that resolves beneath the input root", () => {
    expect(() => assertWithinInputRoot("/run/input/a/b.md", "/run/input", "a/b.md")).not.toThrow();
  });

  test("rejects a path that escapes the input root", () => {
    expect(() => assertWithinInputRoot("/run/other/b.md", "/run/input", "../other/b.md"))
      .toThrow("bundle file path escapes input root");
  });
});

describe("bundle hash recomputation", () => {
  test("matches context-version-files.ts's sha256([path, sha256, bytes]) algorithm, excluding reserved paths", () => {
    const files = {
      "input/context/product/index.md": "# Product\n",
      "input/prompt.md": "the prompt",
      "input/output-schema.json": '{"type":"object"}\n',
    };
    const reserved = new Set(["input/prompt.md", "input/output-schema.json"]);
    const expected = createHash("sha256")
      .update(JSON.stringify([[
        "input/context/product/index.md",
        createHash("sha256").update(Buffer.from("# Product\n", "utf8")).digest("hex"),
        Buffer.byteLength("# Product\n", "utf8"),
      ]]))
      .digest("hex");
    expect(recomputeBundleHash(files, reserved)).toBe(expected);
  });

  test("changes when non-reserved content changes", () => {
    const reserved = new Set<string>();
    const a = recomputeBundleHash({ "input/run.json": "{}" }, reserved);
    const b = recomputeBundleHash({ "input/run.json": "{ }" }, reserved);
    expect(a).not.toBe(b);
  });
});

describe("fetchAndWriteBundle", () => {
  test("writes verified files beneath the input root", async () => {
    const inputRoot = mkdtempSync(join(tmpdir(), "draft-bundle-"));
    const files = {
      "input/context/product/index.md": "# Product\n",
      "input/prompt.md": "the prompt",
      "input/output-schema.json": '{"type":"object"}\n',
    };
    const reserved = new Set(["input/prompt.md", "input/output-schema.json"]);
    const bundleHash = recomputeBundleHash(files, reserved);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ files }), { status: 200 })) as unknown as typeof fetch;
    try {
      await fetchAndWriteBundle(
        "https://storage.example.test/signed",
        bundleHash,
        inputRoot,
        inputRoot,
        reserved,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(existsSync(join(inputRoot, "input/context/product/index.md"))).toBe(true);
    expect(readFileSync(join(inputRoot, "input/prompt.md"), "utf8")).toBe("the prompt");
  });

  test("places files at inputRoot (not bundleRoot/input/input) when bundleRoot is inputRoot's parent, mirroring /run vs /run/input", async () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), "draft-bundle-"));
    const inputRoot = join(bundleRoot, "input");
    const files = {
      "input/context/product/index.md": "# Product\n",
      "input/prompt.md": "the prompt",
    };
    const reserved = new Set(["input/prompt.md", "input/output-schema.json"]);
    const bundleHash = recomputeBundleHash(files, reserved);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ files }), { status: 200 })) as unknown as typeof fetch;
    try {
      await fetchAndWriteBundle(
        "https://storage.example.test/signed",
        bundleHash,
        inputRoot,
        bundleRoot,
        reserved,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(readFileSync(join(inputRoot, "prompt.md"), "utf8")).toBe("the prompt");
    expect(existsSync(join(inputRoot, "input", "prompt.md"))).toBe(false);
  });

  test("rejects a non-OK fetch response", async () => {
    const inputRoot = mkdtempSync(join(tmpdir(), "draft-bundle-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    try {
      await expect(
        fetchAndWriteBundle(
          "https://storage.example.test/signed",
          "0".repeat(64),
          inputRoot,
          inputRoot,
          new Set(),
        ),
      ).rejects.toThrow("bundle fetch returned HTTP 500");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects content that does not match the expected hash", async () => {
    const inputRoot = mkdtempSync(join(tmpdir(), "draft-bundle-"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ files: { "input/run.json": "{}" } }), { status: 200 })) as unknown as typeof fetch;
    try {
      await expect(
        fetchAndWriteBundle(
          "https://storage.example.test/signed",
          "0".repeat(64),
          inputRoot,
          inputRoot,
          new Set(),
        ),
      ).rejects.toThrow("bundle content does not match DRAFT_BUNDLE_HASH");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("batch manifest parsing", () => {
  test("parses a valid manifest and caps it at 25 entries", () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      id: `session-${i}`,
      promptPath: `input/sessions/session-${i}/prompt.md`,
    }));
    const parsed = parseBatchManifest(JSON.stringify(entries));
    expect(parsed).toHaveLength(25);
    expect(parsed[0]).toEqual(entries[0]);
  });

  test("rejects non-array or malformed entries", () => {
    expect(() => parseBatchManifest("not json")).toThrow("valid JSON");
    expect(() => parseBatchManifest("{}")).toThrow("must be a JSON array");
    expect(() => parseBatchManifest('[{"id":"x"}]')).toThrow("promptPath");
    expect(() => parseBatchManifest('[{"id":"","promptPath":"p"}]')).toThrow("promptPath");
  });
});

import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertWithinInputRoot,
  buildFailureDiagnostics,
  callback,
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
  reportRunnerFailure,
  runBatch,
  sanitizeReason,
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

const NO_DELAYS = [0, 0, 0, 0];
const FAILURE_CTX = {
  runId: "run-1",
  bundleHash: "a".repeat(64),
  callbackUrl: "https://api.example.test/sandbox/callback",
  callbackToken: "secret-token-value",
};

async function withFetch<T>(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) =>
    handler(url, init)) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("sanitizeReason", () => {
  test("redacts the token, bearer values and URL query strings, then truncates", () => {
    const error = new Error(
      "fetch failed https://x.test/bundle?token=abc&sig=def with Bearer eyJhbGci and secret-token-value",
    );
    const reason = sanitizeReason(error, "secret-token-value");
    expect(reason).not.toContain("abc");
    expect(reason).not.toContain("eyJhbGci");
    expect(reason).not.toContain("secret-token-value");
    expect(reason).toContain("https://x.test/bundle");
    expect(sanitizeReason("x".repeat(500))).toHaveLength(300);
  });

  test("accepts non-Error throws", () => {
    expect(sanitizeReason("plain string failure")).toBe("plain string failure");
  });
});

describe("reportRunnerFailure", () => {
  test("posts a runner_error failure body with the run identity headers and no transcript", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    await withFetch(
      (url, init) => {
        seen = { url, init };
        return new Response(null, { status: 204 });
      },
      () => reportRunnerFailure(FAILURE_CTX, new Error("boom"), NO_DELAYS),
    );
    expect(seen?.url).toBe(FAILURE_CTX.callbackUrl);
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAILURE_CTX.callbackToken}`);
    expect(headers["x-draft-run-id"]).toBe("run-1");
    expect(headers["idempotency-key"]).toBe(`draft:run-1:${FAILURE_CTX.bundleHash}`);
    expect(JSON.parse(seen?.init.body as string)).toEqual({
      run_id: "run-1",
      bundle_hash: FAILURE_CTX.bundleHash,
      result: { error: "runner_error", diagnostics: { reason: "boom" } },
    });
  });

  test("logs the real error message", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await withFetch(
        () => new Response(null, { status: 204 }),
        () => reportRunnerFailure(FAILURE_CTX, new Error("manifest exploded"), NO_DELAYS),
      );
      const logged = spy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain('"event":"runner_error"');
      expect(logged).toContain("manifest exploded");
    } finally {
      spy.mockRestore();
    }
  });

  test("never throws when every callback attempt fails", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    let calls = 0;
    try {
      await withFetch(
        () => {
          calls += 1;
          throw new Error("network down");
        },
        () => reportRunnerFailure(FAILURE_CTX, new Error("boom"), NO_DELAYS),
      );
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(4);
  });
});

describe("callback retries", () => {
  test("retries a 5xx and stops at the first success", async () => {
    const statuses = [500, 200];
    let calls = 0;
    await withFetch(
      () => new Response(null, { status: statuses[calls++] }),
      () => callback("https://x.test/cb", "t", "run-1", "b".repeat(64), {}, undefined, NO_DELAYS),
    );
    expect(calls).toBe(2);
  });

  test("does not retry a 4xx and throws a delivery error", async () => {
    let calls = 0;
    await withFetch(
      () => {
        calls += 1;
        return new Response(null, { status: 400 });
      },
      async () => {
        await expect(
          callback("https://x.test/cb", "t", "run-1", "b".repeat(64), {}, undefined, NO_DELAYS),
        ).rejects.toThrow("callback returned HTTP 400");
      },
    );
    expect(calls).toBe(1);
  });
});

describe("runBatch", () => {
  test("a session that throws becomes a failed item and the others still report", async () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), "draft-batch-"));
    const inputRoot = join(bundleRoot, "input");
    for (const id of ["a", "b"]) {
      mkdirSync(join(inputRoot, "sessions", id), { recursive: true });
      writeFileSync(join(inputRoot, "sessions", id, "prompt.md"), `prompt ${id}`);
    }
    const manifestPath = join(inputRoot, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify([
        { id: "a", promptPath: "input/sessions/a/prompt.md" },
        { id: "b", promptPath: "input/sessions/b/prompt.md" },
      ]),
    );

    let reported: { finalResult: unknown } | undefined;
    let call = 0;
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runBatch(
        {
          runId: "run-1",
          bundleHash: "c".repeat(64),
          manifestPath,
          serializedSchema: "{}",
          inputRoot,
          bundleRoot,
          timeoutMs: 1_000,
          callbackUrl: "https://x.test/cb",
          callbackToken: "tok",
        },
        {
          runClaudeOnce: (async () => {
            call += 1;
            if (call === 1) throw new Error("spawn gosu ENOENT");
            return { success: true, finalResult: { who: "ido" } };
          }) as never,
          reportAndExit: (async (input: { finalResult: unknown }) => {
            reported = input;
          }) as never,
        },
      );
    } finally {
      spy.mockRestore();
    }

    expect(reported?.finalResult).toEqual({
      items: [
        {
          sessionId: "a",
          ok: false,
          error: { error: "runner_error", diagnostics: { reason: "spawn gosu ENOENT" } },
        },
        { sessionId: "b", ok: true, payload: { who: "ido" } },
      ],
    });
  });
});

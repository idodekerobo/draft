import { describe, expect, spyOn, test } from "bun:test";
import { CLOUD_NATIVE_TOOLS } from "draft-core/run-spec";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertWithinInputRoot, fetchAndWriteBundle, readOutputSchema, recomputeBundleHash } from "../../sandbox/runner/bundle";
import { buildFailureDiagnostics } from "../../sandbox/runner/failure";
import { callback, reportRunnerFailure, shouldRetryCallback } from "../../sandbox/runner/callback";
import { classifyClaudeEnvelopeFailure, claudeMcpConfigJson, extractStructuredOutput, claudeArgs, parseCompletedClaudeEnvelope, parseResultPayload, parseStreamJsonTranscript, sanitizedClaudeEnv } from "draft-core/harnesses/claude/runner";
import { classifyFailureChunk } from "draft-core/harnesses/failure";
import { codexConfigToml, codexMcpConfigToml, codexArgs, parseAgentIds, parseCodexResultLine, sanitizedCodexEnv } from "draft-core/harnesses/codex/runner";
import { parseBatchManifest, runBatch } from "../../sandbox/runner/batch";
import { parseTimeoutSeconds, loadRunnerManifest, manifestFromLegacyEnv } from "../../sandbox/runner/manifest";
import { harnessCommand } from "../../sandbox/runner/process";
import { parseRunnerManifest, validateRunnerManifest, type RunnerManifest } from "draft-core/run-manifest";
import { routineFailureCode, StreamLineReader } from "../../sandbox/runner/stream";
import { sanitizeReason } from "../../sandbox/runner/log";

const CALLBACK = "https://api.example.com/sandbox/callback";
const MCP_URL = "https://api.example.com/runs/11111111-1111-4111-8111-111111111111/mcp";

function manifestOf(overrides: Partial<RunnerManifest> = {}): RunnerManifest {
  return {
    version: 1,
    harness: "claude",
    model: null,
    prompt: { kind: "file", path: "/run/input/prompt.md" },
    tools: { native: ["Read", "Glob"], draftMcpUrl: null },
    output: { kind: "stream" },
    timeoutSeconds: 900,
    ...overrides,
  };
}

const structured: RunnerManifest["output"] = { kind: "structured", schemaPath: "/run/input/output-schema.json" };

test("Claude command is read-only, noninteractive, ephemeral, streamed, and schema-constrained", () => {
  const schema = '{"type":"object","required":["outcome"]}';
  expect(claudeArgs(manifestOf({ output: structured }), "inspect the input", schema)).toEqual([
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

test("structured output cannot start without a schema", () => {
  expect(() => claudeArgs(manifestOf({ output: structured }), "go", null)).toThrow("needs a schema");
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
    expect(classifyFailureChunk("OAuth token rejected: secret-value")).toBe("auth");
    expect(classifyFailureChunk("HTTP 429 from service")).toBe("rate_limit");
    expect(classifyFailureChunk("EACCES permission denied")).toBe("permission");
    expect(classifyFailureChunk("socket ECONNRESET")).toBe("network");
    expect(classifyFailureChunk("unexpected internal detail")).toBe("other");
    expect(classifyFailureChunk("")).toBe("none");
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
          manifest: manifestOf({ output: structured, prompt: { kind: "items", manifestPath } }),
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
          runStructured: (async () => {
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

test("routine command streams stream-json, stays read-only, and sets no JSON schema", () => {
  const args = claudeArgs(manifestOf({ model: "haiku" }), "Summarize", null);
  expect(args).toEqual([
    "-p", "Summarize", "--model", "haiku", "--tools", "Read,Glob", "--permission-mode", "dontAsk",
    "--no-session-persistence", "--output-format", "stream-json", "--verbose",
  ]);
  expect(args).not.toContain("--json-schema");
  expect(claudeArgs(manifestOf(), "Summarize", null)).not.toContain("--model");
});

describe("Draft tools for a run", () => {
  test("Claude gets only Draft's server, allowed by server name, with the token read from the environment", () => {
    const args = claudeArgs(manifestOf({ tools: { native: ["Read", "Glob"], draftMcpUrl: MCP_URL } }), "Summarize", null);
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
    expect(config).toEqual({ mcpServers: { draft: { type: "http", url: MCP_URL, headers: { Authorization: "Bearer ${DRAFT_RUN_TOKEN}" } } } });
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(args.indexOf("--allowedTools"), args.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", "mcp__draft"]);
    expect(args.slice(0, 2)).toEqual(["-p", "Summarize"]);
    expect(args).toContain("Read,Glob");
    expect(JSON.stringify(args)).not.toMatch(/Bearer [A-Za-z0-9]/);
  });

  test("without a tool server the Claude command has no tool-server flags", () => {
    expect(claudeArgs(manifestOf(), "Summarize", null)).not.toContain("--mcp-config");
    expect(claudeMcpConfigJson(MCP_URL)).toContain("${DRAFT_RUN_TOKEN}");
  });

  test("a structured run can use the tool server too", () => {
    const args = claudeArgs(manifestOf({ output: structured, tools: { native: ["Read", "Glob"], draftMcpUrl: MCP_URL } }), "Go", '{"type":"object"}');
    expect(args).toContain("--mcp-config");
    expect(args.slice(-2)).toEqual(["--json-schema", '{"type":"object"}']);
  });

  test("Codex config names the server, takes the token from the environment and needs no approval", () => {
    const toml = codexMcpConfigToml(MCP_URL);
    expect(toml).toContain("[mcp_servers.draft]");
    expect(toml).toContain(`url = "${MCP_URL}"`);
    expect(toml).toContain('bearer_token_env_var = "DRAFT_RUN_TOKEN"');
    expect(toml).toContain("required = true");
    expect(toml).toContain('default_tools_approval_mode = "approve"');
  });

  test("the child gets the run token and nothing else of ours", () => {
    expect(sanitizedClaudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t", DRAFT_RUN_TOKEN: "run-token", DRAFT_CALLBACK_TOKEN: "cb" }).DRAFT_RUN_TOKEN).toBe("run-token");
    expect(sanitizedClaudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "t" })).not.toHaveProperty("DRAFT_RUN_TOKEN");
    const codex = sanitizedCodexEnv({ DRAFT_RUN_TOKEN: "run-token", DRAFT_CALLBACK_TOKEN: "cb" });
    expect(codex.DRAFT_RUN_TOKEN).toBe("run-token");
    expect(JSON.stringify(codex)).not.toContain("cb");
  });
});

describe("built-in tools of a run", () => {
  test("a tool outside the list for that harness is refused", () => {
    const withTools = (harness: "claude" | "codex", native: string[]) => validateRunnerManifest({ ...manifestOf({ harness }), tools: { native, draftMcpUrl: null } }, { callbackUrl: CALLBACK });
    expect(withTools("claude", ["Read", "Glob", "WebSearch"]).tools.native).toEqual(["Read", "Glob", "WebSearch"]);
    expect(() => withTools("claude", ["Read", "Bash"])).toThrow("may not use");
    expect(() => withTools("codex", ["shell", "WebSearch"])).toThrow("may not use");
    expect(withTools("claude", ["Read", "Read"]).tools.native).toEqual(["Read"]);
  });

  test("Claude names every tool that is not read-only in its allow rules, and keeps Draft's server", () => {
    const args = claudeArgs(manifestOf({ tools: { native: ["Read", "Glob", "WebSearch"], draftMcpUrl: MCP_URL } }), "Go", null);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,WebSearch");
    const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--no-session-persistence"));
    expect(allowed).toEqual(["mcp__draft", "WebSearch"]);
  });

  test("Claude with only read-only tools and no server has no allow rules at all", () => {
    expect(claudeArgs(manifestOf({ tools: { native: ["Read", "Glob", "Grep"], draftMcpUrl: null } }), "Go", null)).not.toContain("--allowedTools");
  });

  test("Codex turns web search on in its config, ahead of the server table", () => {
    const toml = codexConfigToml({ mcpUrl: MCP_URL, webSearch: true });
    expect(toml.indexOf('web_search = "live"')).toBeGreaterThanOrEqual(0);
    expect(toml.indexOf('web_search = "live"')).toBeLessThan(toml.indexOf("[mcp_servers.draft]"));
    expect(codexConfigToml({ mcpUrl: null, webSearch: true })).toBe('web_search = "live"');
    expect(codexConfigToml({ mcpUrl: null, webSearch: false })).toBe("");
  });
});

describe("a manifest from the older environment variables", () => {
  const base = { DRAFT_TIMEOUT_SECONDS: "1200" };

  test("synthesis: one prompt, a structured result, Read and Glob", () => {
    expect(manifestFromLegacyEnv(base, CALLBACK)).toEqual(
      manifestOf({ timeoutSeconds: 1200, output: structured }),
    );
  });

  test("summarization: a file of items, a structured result", () => {
    expect(manifestFromLegacyEnv({ ...base, DRAFT_RUN_MODE: "batch", DRAFT_MANIFEST_PATH: "/run/input/manifest.json" }, CALLBACK)).toEqual(
      manifestOf({ timeoutSeconds: 1200, output: structured, prompt: { kind: "items", manifestPath: "/run/input/manifest.json" } }),
    );
    expect(() => manifestFromLegacyEnv({ ...base, DRAFT_RUN_MODE: "batch" }, CALLBACK)).toThrow("DRAFT_MANIFEST_PATH is required");
  });

  test("a Claude routine with a model, web search and Draft's tools", () => {
    expect(
      manifestFromLegacyEnv({ ...base, DRAFT_RUN_MODE: "routine", DRAFT_ROUTINE_MODEL: "haiku", DRAFT_NATIVE_TOOLS: "Read,Glob,WebSearch", DRAFT_MCP_URL: MCP_URL }, CALLBACK),
    ).toEqual(manifestOf({ timeoutSeconds: 1200, model: "haiku", tools: { native: ["Read", "Glob", "WebSearch"], draftMcpUrl: MCP_URL } }));
  });

  test("a Codex routine", () => {
    expect(manifestFromLegacyEnv({ ...base, DRAFT_RUN_MODE: "routine", DRAFT_RUN_HARNESS: "codex", DRAFT_NATIVE_TOOLS: "shell,web_search" }, CALLBACK)).toEqual(
      manifestOf({ timeoutSeconds: 1200, harness: "codex", tools: { native: ["shell", "web_search"], draftMcpUrl: null } }),
    );
  });

  test("a manifest in the environment wins over the older variables", () => {
    const chosen = manifestOf({ model: "sonnet", timeoutSeconds: 60 });
    expect(loadRunnerManifest({ DRAFT_RUN_MANIFEST: JSON.stringify(chosen), DRAFT_RUN_MODE: "batch", DRAFT_ROUTINE_MODEL: "haiku" }, CALLBACK)).toEqual(chosen);
    expect(loadRunnerManifest({ ...base }, CALLBACK).output.kind).toBe("structured");
  });
});

describe("the command for a harness", () => {
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "login", DRAFT_RUN_TOKEN: "run" };

  test("Claude takes the prompt as an argument, runs in /run and has no stdin", () => {
    const command = harnessCommand(manifestOf(), "PROMPT", null, env);
    expect(command.argv[0]).toBe("claude");
    expect(command.argv.slice(1, 3)).toEqual(["-p", "PROMPT"]);
    expect(command.stdin).toBeNull();
    expect(command.cwd).toBe("/run");
    expect(command.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("login");
  });

  test("Codex takes the prompt on stdin and runs in its work folder", () => {
    const command = harnessCommand(manifestOf({ harness: "codex", tools: { native: ["shell"], draftMcpUrl: null } }), "PROMPT", null, env);
    expect(command.argv).toEqual(["codex", ...codexArgs(manifestOf({ harness: "codex", tools: { native: ["shell"], draftMcpUrl: null } }))]);
    expect(command.stdin).toBe("PROMPT");
    expect(command.cwd).toBe("/home/agent/work");
    expect(command.env.CODEX_HOME).toBe("/home/agent/.codex");
    expect(command.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });
});

describe("StreamLineReader", () => {
  test("gives a line the same byte offset however the chunks fall", () => {
    const whole = new StreamLineReader().push('{"a":1}\n{"b":"é"}\n');
    const reader = new StreamLineReader();
    const split = [...reader.push('{"a":1}\n{"b"'), ...reader.push(':"é"}\n')];
    expect(split).toEqual(whole);
    expect(whole.map((line) => line.offset)).toEqual([0, 8]);
  });

  test("holds a partial line until it ends, then returns it from finish", () => {
    const reader = new StreamLineReader();
    expect(reader.push('{"a":1}')).toEqual([]);
    expect(reader.finish()).toEqual([{ file: "root.jsonl", offset: 0, raw: '{"a":1}' }]);
  });

  test("skips blank lines and reports an oversize line by size only", () => {
    const reader = new StreamLineReader();
    const huge = "x".repeat(4 * 1024 * 1024 + 1);
    expect(reader.push(`\n${huge}\n`)).toEqual([{ file: "root.jsonl", offset: 1, oversizeBytes: huge.length }]);
  });
});

test("a routine failure is named by the first cause that applies", () => {
  const base = { timedOut: false, resultIsError: false, exitCode: 0, signal: null };
  expect(routineFailureCode({ ...base, timedOut: true, resultIsError: true })).toBe("timeout");
  expect(routineFailureCode({ ...base, resultIsError: true, exitCode: 1 })).toBe("claude_error");
  expect(routineFailureCode({ ...base, exitCode: 1 })).toBe("claude_exit");
  expect(routineFailureCode({ ...base, signal: "SIGKILL" })).toBe("claude_exit");
  expect(routineFailureCode(base)).toBe("incomplete_result");
});

describe("Codex routine run", () => {
  test("the command reads the prompt from stdin, may write only in its work folder and keeps nothing on disk", () => {
    const codex = (model: string | null) => manifestOf({ harness: "codex", model, tools: { native: ["shell"], draftMcpUrl: null } });
    expect(codexArgs(codex("gpt-6-luna"))).toEqual(["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-m", "gpt-6-luna", "-"]);
    expect(codexArgs(codex(null))).not.toContain("-m");
  });

  test("the child gets its own home and no token of ours", () => {
    const env = sanitizedCodexEnv({ LANG: "en_US.UTF-8", TZ: "UTC", CODEX_AUTH_JSON: "secret", CLAUDE_CODE_OAUTH_TOKEN: "other", PATH: "/evil" });
    expect(env).toEqual({
      HOME: "/home/agent",
      USER: "agent",
      LOGNAME: "agent",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "en_US.UTF-8",
      CODEX_HOME: "/home/agent/.codex",
      TZ: "UTC",
    });
    expect(JSON.stringify(env)).not.toContain("secret");
  });

  test("a finished turn is the result, a failed turn is an error result, and other lines are neither", () => {
    expect(parseCodexResultLine('{"type":"turn.completed","usage":{}}')).toEqual({ is_error: false, subtype: "turn.completed" });
    expect(parseCodexResultLine('{"type":"turn.failed","error":{"message":"x"}}')).toEqual({ is_error: true, subtype: "turn.failed" });
    expect(parseCodexResultLine('{"type":"item.completed"}')).toBeNull();
    expect(parseCodexResultLine('{"type":"turn.completed"')).toBeNull();
    expect(parseCodexResultLine('{"type":"item.completed","item":{"text":"\\"type\\":\\"turn.completed\\""}}')).toBeNull();
  });

  test("a failure is named for Codex, and a Claude run keeps its names", () => {
    const base = { timedOut: false, resultIsError: false, exitCode: 0, signal: null };
    expect(routineFailureCode({ ...base, resultIsError: true, harness: "codex" })).toBe("codex_error");
    expect(routineFailureCode({ ...base, exitCode: 1, harness: "codex" })).toBe("codex_exit");
    expect(routineFailureCode({ ...base, timedOut: true, harness: "codex" })).toBe("timeout");
    expect(routineFailureCode({ ...base, resultIsError: true })).toBe("claude_error");
  });
});

describe("the agent user's ids", () => {
  test("reads agent's own ids, not the 1000 that the base image gives to node", () => {
    const passwd = "root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash\nagent:x:1001:1001::/home/agent:/bin/bash\n";
    expect(parseAgentIds(passwd)).toEqual({ uid: 1001, gid: 1001 });
  });

  test("is null when agent is not listed or the line is broken", () => {
    expect(parseAgentIds("node:x:1000:1000::/home/node:/bin/bash\n")).toBeNull();
    expect(parseAgentIds("agent:x:abc:def::/home/agent:/bin/bash\n")).toBeNull();
    expect(parseAgentIds("")).toBeNull();
  });
});

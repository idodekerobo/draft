// Pins what every kind of sandbox run is started with: the environment the launcher sets and the
// command the runner builds. These values are the contract with the image already deployed.
// The expected values were recorded from the code before the runner read a manifest, and have not changed.
import { describe, expect, it } from "bun:test";
import { launchSandboxRun } from "../../sandbox/launch";
import { createFlyProvider } from "../../sandbox/providers/fly/provider";
import { claudeArgs, sanitizedClaudeEnv } from "draft-core/harnesses/claude/runner";
import { codexArgs, codexConfigToml, sanitizedCodexEnv } from "draft-core/harnesses/codex/runner";
import { type RunnerManifest } from "draft-core/run-manifest";
import { buildRoutineRunSpec } from "../../routines/run-spec";
import { buildSummarizationRunSpec } from "../../summarization/run-spec";
import { buildSynthesisRunSpec } from "../../synthesis/run-spec";

const MCP_URL = "https://api.example.test/runs/11111111-1111-4111-8111-111111111111/mcp";
const SCHEMA = '{"type":"object","required":["outcome"]}';
const STRUCTURED: RunnerManifest["output"] = { kind: "structured", schemaPath: "/run/input/output-schema.json" };

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

describe("commands the runner builds", () => {
  it("synthesis and each summarization item: structured result, Read and Glob only", () => {
    expect(claudeArgs(manifestOf({ output: STRUCTURED }), "PROMPT", SCHEMA)).toEqual([
      "-p", "PROMPT",
      "--tools", "Read,Glob",
      "--permission-mode", "dontAsk",
      "--no-session-persistence",
      "--output-format", "stream-json",
      "--verbose",
      "--json-schema", SCHEMA,
    ]);
  });

  it("a Claude routine with no extras", () => {
    expect(claudeArgs(manifestOf(), "PROMPT", null)).toEqual([
      "-p", "PROMPT",
      "--tools", "Read,Glob",
      "--permission-mode", "dontAsk",
      "--no-session-persistence",
      "--output-format", "stream-json",
      "--verbose",
    ]);
  });

  it("a Claude routine with a model", () => {
    expect(claudeArgs(manifestOf({ model: "haiku" }), "PROMPT", null)).toEqual([
      "-p", "PROMPT",
      "--model", "haiku",
      "--tools", "Read,Glob",
      "--permission-mode", "dontAsk",
      "--no-session-persistence",
      "--output-format", "stream-json",
      "--verbose",
    ]);
  });

  it("a Claude routine with Draft's tool server and web search", () => {
    const args = claudeArgs(manifestOf({ tools: { native: ["Read", "Glob", "WebSearch"], draftMcpUrl: MCP_URL } }), "PROMPT", null);
    expect(args).toEqual([
      "-p", "PROMPT",
      "--tools", "Read,Glob,WebSearch",
      "--permission-mode", "dontAsk",
      "--mcp-config", JSON.stringify({ mcpServers: { draft: { type: "http", url: MCP_URL, headers: { Authorization: "Bearer ${DRAFT_RUN_TOKEN}" } } } }),
      "--strict-mcp-config",
      "--allowedTools", "mcp__draft", "WebSearch",
      "--no-session-persistence",
      "--output-format", "stream-json",
      "--verbose",
    ]);
  });

  it("a Codex routine", () => {
    const codex = (model: string | null) => manifestOf({ harness: "codex", model, tools: { native: ["shell"], draftMcpUrl: null } });
    expect(codexArgs(codex(null))).toEqual(["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-"]);
    expect(codexArgs(codex("gpt-6-luna"))).toEqual(["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-m", "gpt-6-luna", "-"]);
  });

  it("the Codex config: web search first, then Draft's server", () => {
    expect(codexConfigToml({ mcpUrl: MCP_URL, webSearch: true })).toBe(
      [
        'web_search = "live"',
        "[mcp_servers.draft]",
        `url = "${MCP_URL}"`,
        'bearer_token_env_var = "DRAFT_RUN_TOKEN"',
        "required = true",
        'default_tools_approval_mode = "approve"',
        "",
      ].join("\n"),
    );
  });
});

describe("environments the runner gives the harness", () => {
  it("Claude gets its login and the run token, and nothing else of ours", () => {
    expect(sanitizedClaudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "login", LANG: "en_US.UTF-8", TZ: "UTC", DRAFT_RUN_TOKEN: "run", DRAFT_CALLBACK_TOKEN: "cb", CODEX_AUTH_JSON: "x" })).toEqual({
      HOME: "/home/agent",
      USER: "agent",
      LOGNAME: "agent",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "en_US.UTF-8",
      CLAUDE_CODE_OAUTH_TOKEN: "login",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      TZ: "UTC",
      DRAFT_RUN_TOKEN: "run",
    });
  });

  it("Codex gets its own home and the run token", () => {
    expect(sanitizedCodexEnv({ LANG: "en_US.UTF-8", TZ: "UTC", DRAFT_RUN_TOKEN: "run", CODEX_AUTH_JSON: "x" })).toEqual({
      HOME: "/home/agent",
      USER: "agent",
      LOGNAME: "agent",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "en_US.UTF-8",
      CODEX_HOME: "/home/agent/.codex",
      TZ: "UTC",
      DRAFT_RUN_TOKEN: "run",
    });
  });
});

const config = {
  callbackUrl: "https://api.example.test/sandbox/callback",
  callbackSecret: "callback-signing-secret",
  supabaseUrl: "https://project.supabase.co",
  provider: {
    kind: "fly" as const,
    apiToken: "fly-token",
    appName: "draft-sandbox-test",
    image: `registry.fly.io/draft-sandbox-test@sha256:${"a".repeat(64)}`,
    region: "iad",
  },
};

const WS = "22222222-2222-4222-8222-222222222222";
const VERSION = "44444444-4444-4444-8444-444444444444";
const TASK = "55555555-5555-4555-8555-555555555555";
const RUN = "11111111-1111-4111-8111-111111111111";
const OBJECT_SCHEMA = { type: "object" };

async function launched(input: Record<string, unknown>) {
  let env: Record<string, string> = {};
  const uploaded: string[] = [];
  await launchSandboxRun(
    { bundle: { organizationId: "org", workspaceId: WS, runId: "RUN-ID", bundleHash: "b".repeat(64), files: { "input/context/a.md": { content: "A" } } }, config, ...input } as never,
    {
      provider: createFlyProvider(config.provider, {
        create: async (machine) => {
          env = machine.env ?? {};
          return { id: "m1", state: "created" } as never;
        },
        waitForState: async () => ({ id: "m1", state: "started" }) as never,
        forceDelete: async () => undefined,
      }),
      bundleUploader: async (upload) => {
        uploaded.push(...Object.keys(upload.files));
        return { signedUrl: "https://storage.example.test/bundle?sig=secret" } as never;
      },
      now: () => 1_000,
    },
  );
  // Tokens differ on every run; they are checked in their own tests.
  const redacted = { ...env };
  for (const name of ["DRAFT_CALLBACK_TOKEN", "DRAFT_RUN_TOKEN"]) if (redacted[name]) redacted[name] = "<token>";
  return { env: redacted, uploaded: uploaded.sort() };
}

const BASE_ENV = {
  DRAFT_RUN_ID: "RUN-ID",
  DRAFT_BUNDLE_HASH: "b".repeat(64),
  DRAFT_BUNDLE_URL: "https://storage.example.test/bundle?sig=secret",
  DRAFT_EGRESS_HOSTS: "project.supabase.co",
  DRAFT_CALLBACK_URL: "https://api.example.test/sandbox/callback",
  DRAFT_CALLBACK_TOKEN: "<token>",
  DRAFT_PROMPT_PATH: "/run/input/prompt.md",
};

const synthesisSpec = () =>
  buildSynthesisRunSpec({ runId: RUN, workspaceId: WS, triggerType: "manual", contextVersionId: VERSION, resultSchema: OBJECT_SCHEMA });
const summarizationSpec = () =>
  buildSummarizationRunSpec({ id: RUN, workspaceId: WS, scheduledTaskId: TASK, occurrenceAt: "2026-11-09T03:00:00.000Z", contextVersionId: VERSION, resultSchema: OBJECT_SCHEMA });
const routineSpec = (routine: { harness: "claude" | "codex"; model: string | null; environment?: { nativeTools: string[]; mcpServers: [] } }) =>
  buildRoutineRunSpec({ id: RUN, workspaceId: WS, scheduledTaskId: TASK, ownerUserId: "66666666-6666-4666-8666-666666666666", occurrenceAt: "2026-11-09T09:00:00.000Z", routine: { title: "t", prompt: "p", ...routine }, contextVersionId: VERSION });

// The older variables, unchanged, plus the manifest. An image that has not been replaced reads the older ones.
const withManifest = (env: Record<string, string>, manifest: RunnerManifest) => ({ ...env, DRAFT_RUN_MANIFEST: JSON.stringify(manifest) });

describe("environments the launcher gives the machine", () => {
  it("synthesis", async () => {
    const result = await launched({ spec: synthesisSpec(), prompt: { kind: "text", text: "PROMPT" }, credentials: { claudeCodeOAuthToken: "login" } });
    expect(result.env).toEqual(
      withManifest(
        { ...BASE_ENV, DRAFT_TIMEOUT_SECONDS: "1200", CLAUDE_CODE_OAUTH_TOKEN: "login", DRAFT_OUTPUT_SCHEMA_PATH: "/run/input/output-schema.json" },
        manifestOf({ timeoutSeconds: 1200, output: STRUCTURED }),
      ),
    );
    expect(result.uploaded).toEqual(["input/context/a.md", "input/output-schema.json", "input/prompt.md"]);
  });

  it("summarization batch", async () => {
    const result = await launched({ spec: summarizationSpec(), prompt: { kind: "items", manifestPath: "input/manifest.json" }, credentials: { claudeCodeOAuthToken: "login" } });
    expect(result.env).toEqual(
      withManifest(
        {
          ...BASE_ENV, DRAFT_TIMEOUT_SECONDS: "1200", CLAUDE_CODE_OAUTH_TOKEN: "login",
          DRAFT_OUTPUT_SCHEMA_PATH: "/run/input/output-schema.json", DRAFT_RUN_MODE: "batch", DRAFT_MANIFEST_PATH: "/run/input/manifest.json",
        },
        manifestOf({ timeoutSeconds: 1200, output: STRUCTURED, prompt: { kind: "items", manifestPath: "/run/input/manifest.json" } }),
      ),
    );
    expect(result.uploaded).toEqual(["input/context/a.md", "input/output-schema.json"]);
  });

  it("Claude routine with Draft's tools", async () => {
    const result = await launched({
      spec: routineSpec({ harness: "claude", model: "haiku", environment: { nativeTools: ["WebSearch"], mcpServers: [] } }),
      prompt: { kind: "text", text: "PROMPT" },
      timeoutSeconds: 900,
      credentials: { claudeCodeOAuthToken: "login" },
    });
    expect(result.env).toEqual(
      withManifest(
        {
          ...BASE_ENV, DRAFT_TIMEOUT_SECONDS: "900", CLAUDE_CODE_OAUTH_TOKEN: "login", DRAFT_RUN_MODE: "routine", DRAFT_ROUTINE_MODEL: "haiku",
          DRAFT_NATIVE_TOOLS: "Read,Glob,WebSearch", DRAFT_MCP_URL: MCP_URL, DRAFT_RUN_TOKEN: "<token>",
        },
        manifestOf({ model: "haiku", tools: { native: ["Read", "Glob", "WebSearch"], draftMcpUrl: MCP_URL } }),
      ),
    );
    expect(result.uploaded).toEqual(["input/context/a.md", "input/prompt.md"]);
  });

  it("Codex routine", async () => {
    const result = await launched({
      spec: routineSpec({ harness: "codex", model: null, environment: { nativeTools: ["web_search"], mcpServers: [] } }),
      prompt: { kind: "text", text: "PROMPT" },
      timeoutSeconds: 900,
      credentials: { codexAuthJson: "{}" },
    });
    expect(result.env).toEqual(
      withManifest(
        {
          ...BASE_ENV, DRAFT_TIMEOUT_SECONDS: "900", DRAFT_RUN_HARNESS: "codex", CODEX_AUTH_JSON: "{}", DRAFT_RUN_MODE: "routine",
          DRAFT_NATIVE_TOOLS: "shell,web_search", DRAFT_MCP_URL: MCP_URL, DRAFT_RUN_TOKEN: "<token>",
        },
        manifestOf({ harness: "codex", tools: { native: ["shell", "web_search"], draftMcpUrl: MCP_URL } }),
      ),
    );
  });
});

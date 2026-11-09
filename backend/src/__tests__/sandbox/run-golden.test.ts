// Pins what every kind of sandbox run is started with: the environment the launcher sets and the
// command the runner builds. These values are the contract with the image already deployed.
import { describe, expect, it } from "bun:test";
import { parseAgentRunId, parseWorkspaceId } from "draft-core/agent-run";
import { launchFlySandboxRun } from "../../sandbox/fly-sandbox-run";
import {
  claudeCommandArgs,
  codexConfigToml,
  codexRoutineArgs,
  routineCommandArgs,
  sanitizedClaudeEnv,
  sanitizedCodexEnv,
} from "../../sandbox/claude-code/runner";

const MCP_URL = "https://api.example.test/runs/11111111-1111-4111-8111-111111111111/mcp";
const SCHEMA = '{"type":"object","required":["outcome"]}';

describe("commands the runner builds", () => {
  it("synthesis and each summarization item: structured result, Read and Glob only", () => {
    expect(claudeCommandArgs("PROMPT", SCHEMA)).toEqual([
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
    expect(routineCommandArgs("PROMPT", null)).toEqual([
      "-p", "PROMPT",
      "--tools", "Read,Glob",
      "--permission-mode", "dontAsk",
      "--no-session-persistence",
      "--output-format", "stream-json",
      "--verbose",
    ]);
  });

  it("a Claude routine with a model", () => {
    expect(routineCommandArgs("PROMPT", "haiku")).toEqual([
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
    const args = routineCommandArgs("PROMPT", null, MCP_URL, ["Read", "Glob", "WebSearch"]);
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
    expect(codexRoutineArgs(null)).toEqual(["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-"]);
    expect(codexRoutineArgs("gpt-6-luna")).toEqual(["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-m", "gpt-6-luna", "-"]);
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
  flyApiToken: "fly-token",
  flyAppName: "draft-sandbox-test",
  flySandboxImage: `registry.fly.io/draft-sandbox-test@sha256:${"a".repeat(64)}`,
  flyRegion: "iad",
  callbackUrl: "https://api.example.test/sandbox/callback",
  callbackSecret: "callback-signing-secret",
  supabaseUrl: "https://project.supabase.co",
};

async function launched(input: Record<string, unknown>) {
  let env: Record<string, string> = {};
  const uploaded: string[] = [];
  await launchFlySandboxRun(
    { bundle: { organizationId: "org", workspaceId: "ws", runId: "RUN-ID", bundleHash: "b".repeat(64), files: { "input/context/a.md": { content: "A" } } }, config, ...input } as never,
    {
      flyClient: {
        create: async (machine) => {
          env = machine.env ?? {};
          return { id: "m1", state: "created" } as never;
        },
        waitForState: async () => ({ id: "m1", state: "started" }) as never,
        forceDelete: async () => undefined,
      },
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

const RUN_FIELDS = { agentRun: { id: parseAgentRunId("11111111-1111-4111-8111-111111111111"), workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222") } };
const BASE_ENV = {
  DRAFT_RUN_ID: "RUN-ID",
  DRAFT_BUNDLE_HASH: "b".repeat(64),
  DRAFT_BUNDLE_URL: "https://storage.example.test/bundle?sig=secret",
  DRAFT_EGRESS_HOSTS: "project.supabase.co",
  DRAFT_CALLBACK_URL: "https://api.example.test/sandbox/callback",
  DRAFT_CALLBACK_TOKEN: "<token>",
  DRAFT_PROMPT_PATH: "/run/input/prompt.md",
};

describe("environments the launcher gives the machine", () => {
  it("synthesis", async () => {
    const result = await launched({ prompt: "PROMPT", jsonSchema: { type: "object" }, claudeCodeOAuthToken: "login" });
    expect(result.env).toEqual({ ...BASE_ENV, DRAFT_TIMEOUT_SECONDS: "1200", CLAUDE_CODE_OAUTH_TOKEN: "login", DRAFT_OUTPUT_SCHEMA_PATH: "/run/input/output-schema.json" });
    expect(result.uploaded).toEqual(["input/context/a.md", "input/output-schema.json", "input/prompt.md"]);
  });

  it("summarization batch", async () => {
    const result = await launched({ mode: "batch", manifestPath: "input/manifest.json", jsonSchema: { type: "object" }, claudeCodeOAuthToken: "login" });
    expect(result.env).toEqual({
      ...BASE_ENV, DRAFT_TIMEOUT_SECONDS: "1200", CLAUDE_CODE_OAUTH_TOKEN: "login",
      DRAFT_OUTPUT_SCHEMA_PATH: "/run/input/output-schema.json", DRAFT_RUN_MODE: "batch", DRAFT_MANIFEST_PATH: "/run/input/manifest.json",
    });
    expect(result.uploaded).toEqual(["input/context/a.md", "input/output-schema.json"]);
  });

  it("Claude routine with Draft's tools", async () => {
    const result = await launched({ mode: "routine", prompt: "PROMPT", model: "haiku", timeoutSeconds: 900, claudeCodeOAuthToken: "login", nativeTools: ["Read", "Glob", "WebSearch"], ...RUN_FIELDS });
    expect(result.env).toEqual({
      ...BASE_ENV, DRAFT_TIMEOUT_SECONDS: "900", CLAUDE_CODE_OAUTH_TOKEN: "login", DRAFT_RUN_MODE: "routine", DRAFT_ROUTINE_MODEL: "haiku",
      DRAFT_NATIVE_TOOLS: "Read,Glob,WebSearch", DRAFT_MCP_URL: MCP_URL, DRAFT_RUN_TOKEN: "<token>",
    });
    expect(result.uploaded).toEqual(["input/context/a.md", "input/prompt.md"]);
  });

  it("Codex routine", async () => {
    const result = await launched({ mode: "routine", prompt: "PROMPT", harness: "codex", codexAuthJson: "{}", timeoutSeconds: 900, nativeTools: ["shell", "web_search"], ...RUN_FIELDS });
    expect(result.env).toEqual({
      ...BASE_ENV, DRAFT_TIMEOUT_SECONDS: "900", DRAFT_RUN_HARNESS: "codex", CODEX_AUTH_JSON: "{}", DRAFT_RUN_MODE: "routine",
      DRAFT_NATIVE_TOOLS: "shell,web_search", DRAFT_MCP_URL: MCP_URL, DRAFT_RUN_TOKEN: "<token>",
    });
  });
});

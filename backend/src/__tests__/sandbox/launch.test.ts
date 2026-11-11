import { describe, expect, it } from "bun:test";
import type { ValidatedRunBundle } from "../../synthesis/context-version-files";
import type { AgentRunSpec } from "draft-core/run-spec";
import { verifyAgentRunToken } from "../../metaharness/runs/run-token";
import { buildRoutineRunSpec } from "../../routines/run-spec";
import { verifySandboxCallbackToken } from "../../sandbox/callback-token";
import {
  FlyMachineWaitTimeoutError,
  type CreateFlyMachineInput,
  type FlyMachine,
} from "../../sandbox/providers/fly/fly-machines";
import { launchSandboxRun } from "../../sandbox/launch";
import { createFlyProvider, type FlyMachinesApi } from "../../sandbox/providers/fly/provider";
import { validateRunnerManifest } from "draft-core/run-manifest";
import { buildSummarizationRunSpec } from "../../summarization/run-spec";
import { buildSynthesisRunSpec } from "../../synthesis/run-spec";

const parseManifest = (value: unknown) => validateRunnerManifest(value, { callbackUrl: "https://api.example.test/sandbox/callback" });
const bundleHash = "b".repeat(64);
const image = `registry.fly.io/draft@sha256:${"a".repeat(64)}`;
const config = {
  callbackUrl: "https://api.example.test/sandbox/callback",
  callbackSecret: "callback-signing-secret",
  supabaseUrl: "https://project.supabase.co",
  provider: { kind: "fly" as const, apiToken: "fly-api-secret", appName: "draft-sandbox", image, region: "iad" },
};
const flyProvider = (client: FlyMachinesApi) => createFlyProvider(config.provider, client);
const jsonSchema = {
  required: ["outcome"],
  properties: { outcome: { type: "string" } },
  additionalProperties: false,
  type: "object",
};

const WS = "22222222-2222-4222-8222-222222222222";
const RUN = "11111111-1111-4111-8111-111111111111";
const TASK = "55555555-5555-4555-8555-555555555555";
const VERSION = "44444444-4444-4444-8444-444444444444";

const synthesisSpec = (): AgentRunSpec =>
  buildSynthesisRunSpec({ runId: RUN, workspaceId: WS, triggerType: "manual", contextVersionId: VERSION, resultSchema: jsonSchema });
const batchSpec = (): AgentRunSpec =>
  buildSummarizationRunSpec({ id: RUN, workspaceId: WS, scheduledTaskId: TASK, occurrenceAt: "2026-11-09T03:00:00.000Z", contextVersionId: VERSION, resultSchema: jsonSchema });
const routineSpec = (
  routine: { harness?: "claude" | "codex"; model?: string | null; environment?: { nativeTools: string[]; mcpServers: [] } } = {},
): AgentRunSpec =>
  buildRoutineRunSpec({
    id: RUN,
    workspaceId: WS,
    scheduledTaskId: TASK,
    ownerUserId: "66666666-6666-4666-8666-666666666666",
    occurrenceAt: "2026-11-09T09:00:00.000Z",
    routine: { title: "t", prompt: "p", harness: "claude", model: null, ...routine },
    contextVersionId: VERSION,
  });

const claudeLogin = { claudeCodeOAuthToken: "token" };
const text = (value: string) => ({ kind: "text" as const, text: value });

function bundle(files?: ValidatedRunBundle["files"]): ValidatedRunBundle {
  return {
    organizationId: "organization",
    teamId: "team",
    workspaceId: "workspace",
    runId: "run-123",
    baseContextVersionId: "version",
    promptVersion: "v1",
    files: files ?? {
      "input/context/product/index.md": {
        content: "# Product\n",
        sha256: "1".repeat(64),
        bytes: 10,
      },
      "input/run.json": {
        content: '{"run":true}\n',
        sha256: "2".repeat(64),
        bytes: 13,
      },
    },
    totalBytes: 23,
    bundleHash,
    outputPath: "output/result.json",
  };
}

function fakeFlyClient(overrides: {
  createState?: string;
  waitForState?: FlyMachinesApi["waitForState"];
} = {}): { client: FlyMachinesApi; forceDeleted: string[] } {
  const forceDeleted: string[] = [];
  const client: FlyMachinesApi = {
    create: async () => ({ id: "machine-1", state: overrides.createState ?? "created" }),
    waitForState:
      overrides.waitForState ??
      (async (machineId: string): Promise<FlyMachine> => ({ id: machineId, state: "started" })),
    forceDelete: async (machineId: string) => {
      forceDeleted.push(machineId);
    },
  };
  return { client, forceDeleted };
}

function fakeBundleUploader(signedUrl = "https://storage.example.test/signed") {
  const calls: Array<{ organizationId: string; workspaceId: string; runId: string; files: Record<string, string> }> = [];
  const uploader = async (input: {
    organizationId: string;
    workspaceId: string;
    runId: string;
    files: Record<string, string>;
  }) => {
    calls.push(input);
    return { signedUrl, objectKey: `sandbox_uploads/${input.organizationId}/${input.workspaceId}/${input.runId}.json` };
  };
  return { uploader, calls };
}

/** Launches with fakes and returns what the machine was created with and what was uploaded. */
async function launch(input: Record<string, unknown>) {
  const { client } = fakeFlyClient();
  const { uploader, calls } = fakeBundleUploader();
  let launched: CreateFlyMachineInput | undefined;
  await launchSandboxRun({ bundle: bundle(), config, ...input } as never, {
    provider: flyProvider({ ...client, create: async (machine) => { launched = machine; return client.create(machine); } }),
    bundleUploader: uploader,
    now: () => 1_000,
  });
  return { env: launched!.env!, uploads: calls[0]!.files };
}

describe("launchSandboxRun", () => {
  it("uploads the bundle instead of embedding it, and maps sandbox policy without leaking secrets", async () => {
    const { client } = fakeFlyClient();
    const { uploader, calls } = fakeBundleUploader("https://storage.example.test/abc");
    let launched: CreateFlyMachineInput | undefined;
    const wrappedClient: FlyMachinesApi = {
      ...client,
      create: async (input) => {
        launched = input;
        return client.create(input);
      },
    };

    const receipt = await launchSandboxRun({
      spec: synthesisSpec(),
      bundle: bundle(),
      prompt: text("Synthesize this workspace.\n"),
      credentials: { claudeCodeOAuthToken: "claude-oauth-secret" },
      config,
    }, {
      provider: flyProvider(wrappedClient),
      bundleUploader: uploader,
      now: () => 1_000,
      nonce: () => "nonce-123",
    });

    expect(receipt).toEqual({
      machineId: "machine-1",
      state: "started",
      runId: "run-123",
      bundleHash,
      callbackExpiresAt: 1_801_000,
    });

    // Core regression: no bundle content in the Fly Machines create payload.
    expect(launched!.files).toEqual({});

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      organizationId: "organization",
      workspaceId: "workspace",
      runId: "run-123",
      files: {
        "input/context/product/index.md": "# Product\n",
        "input/run.json": '{"run":true}\n',
        "input/prompt.md": "Synthesize this workspace.\n",
        "input/output-schema.json":
          '{"additionalProperties":false,"properties":{"outcome":{"type":"string"}},"required":["outcome"],"type":"object"}\n',
      },
    });

    expect(launched!.image).toBe(image);
    expect(launched!.region).toBe("iad");
    expect(launched!.guest).toEqual({ cpu_kind: "shared", cpus: 1, memory_mb: 1024 });
    expect(launched!.metadata).toEqual({ run_id: "run-123", bundle_hash: bundleHash });
    expect(Object.keys(launched!.env!).sort()).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "DRAFT_BUNDLE_HASH",
      "DRAFT_BUNDLE_URL",
      "DRAFT_CALLBACK_TOKEN",
      "DRAFT_CALLBACK_URL",
      "DRAFT_EGRESS_HOSTS",
      "DRAFT_OUTPUT_SCHEMA_PATH",
      "DRAFT_PROMPT_PATH",
      "DRAFT_RUN_ID",
      "DRAFT_RUN_MANIFEST",
      "DRAFT_TIMEOUT_SECONDS",
    ]);
    expect(launched!.env).toMatchObject({
      DRAFT_RUN_ID: "run-123",
      DRAFT_BUNDLE_HASH: bundleHash,
      DRAFT_BUNDLE_URL: "https://storage.example.test/abc",
      DRAFT_EGRESS_HOSTS: "project.supabase.co",
      DRAFT_CALLBACK_URL: config.callbackUrl,
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-secret",
      DRAFT_PROMPT_PATH: "/run/input/prompt.md",
      DRAFT_OUTPUT_SCHEMA_PATH: "/run/input/output-schema.json",
      DRAFT_TIMEOUT_SECONDS: "1200",
    });
    expect(JSON.stringify(launched)).not.toContain(config.provider.apiToken);
    expect(JSON.stringify(launched)).not.toContain(config.callbackSecret);
    expect(launched!.env!.DRAFT_RUN_MANIFEST).not.toContain("claude-oauth-secret");
    expect(verifySandboxCallbackToken(
      launched!.env!.DRAFT_CALLBACK_TOKEN,
      config.callbackSecret,
      { now: 1_000 },
    )).toEqual({
      runId: "run-123",
      bundleHash,
      expiresAt: 1_801_000,
      nonce: "nonce-123",
    });
  });

  it("confirms the machine reaches started via waitForState", async () => {
    let waited: string | undefined;
    const { client } = fakeFlyClient({
      waitForState: async (machineId) => {
        waited = machineId;
        return { id: machineId, state: "started" };
      },
    });
    const { uploader } = fakeBundleUploader();

    const receipt = await launchSandboxRun({
      spec: synthesisSpec(), bundle: bundle(), prompt: text("prompt"), credentials: claudeLogin, config,
    }, { provider: flyProvider(client), bundleUploader: uploader });

    expect(waited).toBe("machine-1");
    expect(receipt.state).toBe("started");
  });

  it("force-deletes and rethrows on a boot timeout, without masking the original error", async () => {
    const timeoutError = new FlyMachineWaitTimeoutError({
      machineId: "machine-1",
      desiredState: "started",
      lastState: "starting",
      timeoutMs: 60_000,
    });
    const { client, forceDeleted } = fakeFlyClient({
      waitForState: async () => {
        throw timeoutError;
      },
    });
    const { uploader } = fakeBundleUploader();

    await expect(launchSandboxRun({
      spec: synthesisSpec(), bundle: bundle(), prompt: text("prompt"), credentials: claudeLogin, config,
    }, { provider: flyProvider(client), bundleUploader: uploader })).rejects.toBe(timeoutError);

    expect(forceDeleted).toEqual(["machine-1"]);
  });

  it("rejects empty prompts and OAuth tokens before launching", async () => {
    let launches = 0;
    const { client } = fakeFlyClient();
    const flyClient: FlyMachinesApi = {
      ...client,
      create: async (input) => {
        launches += 1;
        return client.create(input);
      },
    };
    const { uploader } = fakeBundleUploader();
    await expect(launchSandboxRun({
      spec: synthesisSpec(), bundle: bundle(), prompt: text(" "), credentials: claudeLogin, config,
    }, { provider: flyProvider(flyClient), bundleUploader: uploader })).rejects.toThrow("prompt must not be empty");
    await expect(launchSandboxRun({
      spec: synthesisSpec(), bundle: bundle(), prompt: text("prompt"), credentials: { claudeCodeOAuthToken: " " }, config,
    }, { provider: flyProvider(flyClient), bundleUploader: uploader })).rejects.toThrow("claudeCodeOAuthToken must not be empty");
    expect(launches).toBe(0);
  });

  it("rejects a bundle collision with the reserved prompt path", async () => {
    const { client } = fakeFlyClient();
    const { uploader } = fakeBundleUploader();
    await expect(launchSandboxRun({
      spec: synthesisSpec(),
      bundle: bundle({
        "input/prompt.md": { content: "forged", sha256: "3".repeat(64), bytes: 6 },
      }),
      prompt: text("real prompt"),
      credentials: claudeLogin,
      config,
    }, { provider: flyProvider(client), bundleUploader: uploader })).rejects.toThrow("reserved prompt path");
  });

  it("rejects a bundle collision with the reserved output schema path", async () => {
    const { client } = fakeFlyClient();
    const { uploader } = fakeBundleUploader();
    await expect(launchSandboxRun({
      spec: synthesisSpec(),
      bundle: bundle({
        "input/output-schema.json": {
          content: "{}",
          sha256: "4".repeat(64),
          bytes: 2,
        },
      }),
      prompt: text("real prompt"),
      credentials: claudeLogin,
      config,
    }, { provider: flyProvider(client), bundleUploader: uploader })).rejects.toThrow("reserved output schema path");
  });

  it("launches a batch without a top-level prompt, naming the items file", async () => {
    const { env, uploads } = await launch({
      spec: batchSpec(),
      prompt: { kind: "items", manifestPath: "input/manifest.json" },
      credentials: { claudeCodeOAuthToken: "claude-oauth-secret" },
    });

    expect(uploads["input/prompt.md"]).toBeUndefined();
    expect(env).toMatchObject({ DRAFT_RUN_MODE: "batch", DRAFT_MANIFEST_PATH: "/run/input/manifest.json" });
    expect(parseManifest(JSON.parse(env.DRAFT_RUN_MANIFEST!)).prompt).toEqual({ kind: "items", manifestPath: "/run/input/manifest.json" });
  });
});

describe("the run manifest the launcher sends", () => {
  it("is valid, holds no secret, and says what the spec says", async () => {
    const { env } = await launch({
      spec: routineSpec({ model: "haiku", environment: { nativeTools: ["WebSearch"], mcpServers: [] } }),
      prompt: text("Go.\n"),
      timeoutSeconds: 900,
      credentials: { claudeCodeOAuthToken: "login-secret" },
    });
    const manifest = parseManifest(JSON.parse(env.DRAFT_RUN_MANIFEST!));
    expect(manifest).toEqual({
      version: 1,
      harness: "claude",
      model: "haiku",
      prompt: { kind: "file", path: "/run/input/prompt.md" },
      tools: { native: ["Read", "Glob", "WebSearch"], draftMcpUrl: `https://api.example.test/runs/${RUN}/mcp` },
      output: { kind: "stream" },
      timeoutSeconds: 900,
    });
    expect(env.DRAFT_RUN_MANIFEST).not.toContain("login-secret");
    expect(env.DRAFT_RUN_MANIFEST).not.toContain(env.DRAFT_RUN_TOKEN!);
  });

  it("changes with the spec: a structured run has a schema path and a Codex run is Codex", async () => {
    const synthesis = parseManifest(JSON.parse((await launch({ spec: synthesisSpec(), prompt: text("p"), credentials: claudeLogin })).env.DRAFT_RUN_MANIFEST!));
    expect(synthesis.output).toEqual({ kind: "structured", schemaPath: "/run/input/output-schema.json" });
    const codex = parseManifest(JSON.parse((await launch({ spec: routineSpec({ harness: "codex" }), prompt: text("p"), credentials: { codexAuthJson: "{}" } })).env.DRAFT_RUN_MANIFEST!));
    expect(codex.harness).toBe("codex");
    expect(codex.tools.native).toEqual(["shell"]);
  });
});

describe("launchSandboxRun routine runs", () => {
  it("runs without an output schema and tells the runner the mode, model and timeout", async () => {
    const { env, uploads } = await launch({
      spec: routineSpec({ model: "haiku" }),
      prompt: text("Summarize the week.\n"),
      timeoutSeconds: 900,
      credentials: claudeLogin,
    });

    expect(Object.keys(uploads)).not.toContain("input/output-schema.json");
    expect(uploads["input/prompt.md"]).toBe("Summarize the week.\n");
    expect(env).toMatchObject({ DRAFT_RUN_MODE: "routine", DRAFT_ROUTINE_MODEL: "haiku", DRAFT_TIMEOUT_SECONDS: "900" });
    expect(env).not.toHaveProperty("DRAFT_OUTPUT_SCHEMA_PATH");
  });

  it("gives a run Draft's tools: a tool server URL on the callback host and a run token", async () => {
    const { env } = await launch({ spec: routineSpec(), prompt: text("Go.\n"), credentials: claudeLogin });

    expect(env.DRAFT_MCP_URL).toBe(`https://api.example.test/runs/${RUN}/mcp`);
    const claims = verifyAgentRunToken(env.DRAFT_RUN_TOKEN!, config.callbackSecret, { now: 1_001 });
    expect(claims).toMatchObject({ runId: RUN, workspaceId: WS });
    expect(() => verifySandboxCallbackToken(env.DRAFT_RUN_TOKEN!, config.callbackSecret, { now: 1_001 })).toThrow();
  });

  it("tells the runner which built-in tools the run may use", async () => {
    const { env } = await launch({
      spec: routineSpec({ environment: { nativeTools: ["WebSearch"], mcpServers: [] } }),
      prompt: text("Go.\n"),
      credentials: claudeLogin,
    });
    expect(env.DRAFT_NATIVE_TOOLS).toBe("Read,Glob,WebSearch");
  });

  it("sets no tool server or run token when the run has no Draft tools", async () => {
    const { env } = await launch({ spec: { ...routineSpec(), permissions: [] }, prompt: text("Go.\n"), credentials: claudeLogin });
    expect(env).not.toHaveProperty("DRAFT_MCP_URL");
    expect(env).not.toHaveProperty("DRAFT_RUN_TOKEN");
    expect(parseManifest(JSON.parse(env.DRAFT_RUN_MANIFEST!)).tools.draftMcpUrl).toBeNull();
  });

  it("gives a structured run Draft's tools too, when its spec holds them", async () => {
    const { env } = await launch({
      spec: buildSynthesisRunSpec({ runId: RUN, workspaceId: WS, triggerType: "manual", contextVersionId: VERSION, resultSchema: jsonSchema, permissions: [{ tool: "context.write" }] }),
      prompt: text("Go.\n"),
      credentials: claudeLogin,
    });
    expect(env.DRAFT_RUN_TOKEN).toBeTruthy();
    expect(parseManifest(JSON.parse(env.DRAFT_RUN_MANIFEST!)).tools.draftMcpUrl).toBe(`https://api.example.test/runs/${RUN}/mcp`);
  });

  it("hands a Codex run its auth file and no Claude token", async () => {
    const { env } = await launch({
      spec: routineSpec({ harness: "codex" }),
      prompt: text("Summarize the week.\n"),
      credentials: { codexAuthJson: "{\"auth_mode\":\"chatgpt\"}" },
    });

    expect(env).toMatchObject({ DRAFT_RUN_HARNESS: "codex", CODEX_AUTH_JSON: "{\"auth_mode\":\"chatgpt\"}", DRAFT_RUN_MODE: "routine" });
    expect(env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("refuses a run with the wrong or empty credentials for its harness", async () => {
    const { client } = fakeFlyClient();
    const { uploader } = fakeBundleUploader();
    const run = (spec: AgentRunSpec, credentials: object) =>
      launchSandboxRun({ spec, bundle: bundle(), prompt: text("p"), credentials: credentials as never, config }, { provider: flyProvider(client), bundleUploader: uploader });
    await expect(run(routineSpec({ harness: "codex" }), { codexAuthJson: " " })).rejects.toThrow("codexAuthJson must not be empty");
    await expect(run(routineSpec({ harness: "codex" }), claudeLogin)).rejects.toThrow("codexAuthJson must not be empty");
    await expect(run(routineSpec(), { codexAuthJson: "{}" })).rejects.toThrow("claudeCodeOAuthToken must not be empty");
  });

  it("refuses a run the sandbox cannot do: Codex with a structured result, a local run, no output", async () => {
    const { client } = fakeFlyClient();
    const { uploader } = fakeBundleUploader();
    const run = (spec: AgentRunSpec, prompt: object = text("p")) =>
      launchSandboxRun({ spec, bundle: bundle(), prompt: prompt as never, credentials: { claudeCodeOAuthToken: "t", codexAuthJson: "{}" }, config }, { provider: flyProvider(client), bundleUploader: uploader });
    await expect(run({ ...routineSpec({ harness: "codex" }), output: { type: "structured", schema: jsonSchema } })).rejects.toThrow("Codex run streams text");
    await expect(run({ ...routineSpec({ harness: "codex" }) }, { kind: "items", manifestPath: "input/manifest.json" })).rejects.toThrow("Codex run streams text");
    await expect(run({ ...routineSpec(), runtime: { type: "local", hostMachineId: "mac" as never } })).rejects.toThrow("cloud runtime");
    await expect(run({ ...routineSpec(), output: { type: "none" } })).rejects.toThrow("text or structured output");
  });
});

describe("the launch plan", () => {
  it("holds no provider detail, and any provider can start it", async () => {
    const started: unknown[] = [];
    const provider = {
      start: async (plan: unknown) => {
        started.push(plan);
        return { machineId: "box-1", state: "running" };
      },
      stop: async () => undefined,
    };
    const { uploader } = fakeBundleUploader();
    const receipt = await launchSandboxRun(
      { spec: routineSpec(), bundle: bundle(), prompt: text("p"), credentials: claudeLogin, config },
      { provider, bundleUploader: uploader, now: () => 1_000 },
    );
    expect(receipt).toMatchObject({ machineId: "box-1", state: "running", bundleHash });
    const plan = started[0] as { env: Record<string, string>; metadata: Record<string, string> };
    expect(Object.keys(plan).sort()).toEqual(["bundleHash", "env", "metadata", "runId"]);
    expect(JSON.stringify(plan)).not.toContain("registry.fly.io");
    expect(JSON.stringify(plan)).not.toContain("fly-api-secret");
  });
});

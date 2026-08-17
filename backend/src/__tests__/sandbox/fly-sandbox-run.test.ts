import { describe, expect, it } from "bun:test";
import type { ValidatedRunBundle } from "../../synthesis/context-version-files";
import { verifySandboxCallbackToken } from "../../sandbox/callback-token";
import {
  FlyMachineWaitTimeoutError,
  type CreateFlyMachineInput,
  type FlyMachine,
} from "../../sandbox/fly-machines";
import {
  launchFlySandboxRun,
  type FlySandboxRunClient,
} from "../../sandbox/fly-sandbox-run";

const bundleHash = "b".repeat(64);
const image = `registry.fly.io/draft@sha256:${"a".repeat(64)}`;
const config = {
  flyApiToken: "fly-api-secret",
  flyAppName: "draft-sandbox",
  flySandboxImage: image,
  flyRegion: "iad",
  callbackUrl: "https://api.example.test/sandbox/callback",
  callbackSecret: "callback-signing-secret",
  supabaseUrl: "https://project.supabase.co",
};
const jsonSchema = {
  required: ["outcome"],
  properties: { outcome: { type: "string" } },
  additionalProperties: false,
  type: "object",
};

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
  waitForState?: FlySandboxRunClient["waitForState"];
} = {}): { client: FlySandboxRunClient; forceDeleted: string[] } {
  const forceDeleted: string[] = [];
  const client: FlySandboxRunClient = {
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

describe("launchFlySandboxRun", () => {
  it("uploads the bundle instead of embedding it, and maps sandbox policy without leaking secrets", async () => {
    const { client } = fakeFlyClient();
    const { uploader, calls } = fakeBundleUploader("https://storage.example.test/abc");
    let launched: CreateFlyMachineInput | undefined;
    const wrappedClient: FlySandboxRunClient = {
      ...client,
      create: async (input) => {
        launched = input;
        return client.create(input);
      },
    };

    const receipt = await launchFlySandboxRun({
      bundle: bundle(),
      prompt: "Synthesize this workspace.\n",
      jsonSchema,
      claudeCodeOAuthToken: "claude-oauth-secret",
      config,
    }, {
      flyClient: wrappedClient,
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
    expect(launched!.guest).toEqual({ cpu_kind: "shared", cpus: 1, memory_mb: 512 });
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
    expect(JSON.stringify(launched)).not.toContain(config.flyApiToken);
    expect(JSON.stringify(launched)).not.toContain(config.callbackSecret);
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

    const receipt = await launchFlySandboxRun({
      bundle: bundle(), prompt: "prompt", jsonSchema, claudeCodeOAuthToken: "token", config,
    }, { flyClient: client, bundleUploader: uploader });

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

    await expect(launchFlySandboxRun({
      bundle: bundle(), prompt: "prompt", jsonSchema, claudeCodeOAuthToken: "token", config,
    }, { flyClient: client, bundleUploader: uploader })).rejects.toBe(timeoutError);

    expect(forceDeleted).toEqual(["machine-1"]);
  });

  it("rejects empty prompts and OAuth tokens before launching", async () => {
    let launches = 0;
    const { client } = fakeFlyClient();
    const flyClient: FlySandboxRunClient = {
      ...client,
      create: async (input) => {
        launches += 1;
        return client.create(input);
      },
    };
    const { uploader } = fakeBundleUploader();
    await expect(launchFlySandboxRun({
      bundle: bundle(), prompt: " ", jsonSchema, claudeCodeOAuthToken: "token", config,
    }, { flyClient, bundleUploader: uploader })).rejects.toThrow("prompt must not be empty");
    await expect(launchFlySandboxRun({
      bundle: bundle(), prompt: "prompt", jsonSchema, claudeCodeOAuthToken: " ", config,
    }, { flyClient, bundleUploader: uploader })).rejects.toThrow("claudeCodeOAuthToken must not be empty");
    expect(launches).toBe(0);
  });

  it("rejects a bundle collision with the reserved prompt path", async () => {
    const { client } = fakeFlyClient();
    const { uploader } = fakeBundleUploader();
    await expect(launchFlySandboxRun({
      bundle: bundle({
        "input/prompt.md": { content: "forged", sha256: "3".repeat(64), bytes: 6 },
      }),
      prompt: "real prompt",
      jsonSchema,
      claudeCodeOAuthToken: "token",
      config,
    }, { flyClient: client, bundleUploader: uploader })).rejects.toThrow("reserved prompt path");
  });

  it("rejects a bundle collision with the reserved output schema path", async () => {
    const { client } = fakeFlyClient();
    const { uploader } = fakeBundleUploader();
    await expect(launchFlySandboxRun({
      bundle: bundle({
        "input/output-schema.json": {
          content: "{}",
          sha256: "4".repeat(64),
          bytes: 2,
        },
      }),
      prompt: "real prompt",
      jsonSchema,
      claudeCodeOAuthToken: "token",
      config,
    }, { flyClient: client, bundleUploader: uploader })).rejects.toThrow("reserved output schema path");
  });
});

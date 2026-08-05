import { describe, expect, it } from "bun:test";
import type { ValidatedRunBundle } from "../../synthesis/context-version-files";
import { verifySandboxCallbackToken } from "../../sandbox/callback-token";
import type { CreateFlyMachineInput } from "../../sandbox/fly-machines";
import { launchFlySandboxRun } from "../../sandbox/fly-sandbox-run";

const bundleHash = "b".repeat(64);
const image = `registry.fly.io/draft@sha256:${"a".repeat(64)}`;
const config = {
  flyApiToken: "fly-api-secret",
  flyAppName: "draft-sandbox",
  flySandboxImage: image,
  flyRegion: "iad",
  callbackUrl: "https://api.example.test/sandbox/callback",
  callbackSecret: "callback-signing-secret",
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

describe("launchFlySandboxRun", () => {
  it("maps the bundle and exact sandbox policy without leaking deployment secrets", async () => {
    let launched: CreateFlyMachineInput | undefined;
    const receipt = await launchFlySandboxRun({
      bundle: bundle(),
      prompt: "Synthesize this workspace.\n",
      jsonSchema,
      claudeCodeOAuthToken: "claude-oauth-secret",
      config,
    }, {
      flyClient: {
        create: async (input) => {
          launched = input;
          return { id: "machine-1", state: "created" };
        },
      },
      now: () => 1_000,
      nonce: () => "nonce-123",
    });

    expect(receipt).toEqual({
      machineId: "machine-1",
      state: "created",
      runId: "run-123",
      bundleHash,
      callbackExpiresAt: 1_801_000,
    });
    expect(launched).toBeDefined();
    expect(launched!.image).toBe(image);
    expect(launched!.region).toBe("iad");
    expect(launched!.guest).toEqual({ cpu_kind: "shared", cpus: 1, memory_mb: 512 });
    expect(launched!.metadata).toEqual({ run_id: "run-123", bundle_hash: bundleHash });
    expect(launched!.files).toEqual({
      "input/context/product/index.md": "# Product\n",
      "input/run.json": '{"run":true}\n',
      "input/prompt.md": "Synthesize this workspace.\n",
      "input/output-schema.json":
        '{"additionalProperties":false,"properties":{"outcome":{"type":"string"}},"required":["outcome"],"type":"object"}\n',
    });
    expect(Object.keys(launched!.env!).sort()).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "DRAFT_BUNDLE_HASH",
      "DRAFT_CALLBACK_TOKEN",
      "DRAFT_CALLBACK_URL",
      "DRAFT_OUTPUT_SCHEMA_PATH",
      "DRAFT_PROMPT_PATH",
      "DRAFT_RUN_ID",
      "DRAFT_TIMEOUT_SECONDS",
    ]);
    expect(launched!.env).toMatchObject({
      DRAFT_RUN_ID: "run-123",
      DRAFT_BUNDLE_HASH: bundleHash,
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

  it("rejects empty prompts and OAuth tokens before launching", async () => {
    let launches = 0;
    const flyClient = {
      create: async () => {
        launches += 1;
        return { id: "unexpected", state: "created" };
      },
    };
    await expect(launchFlySandboxRun({
      bundle: bundle(), prompt: " ", jsonSchema, claudeCodeOAuthToken: "token", config,
    }, { flyClient })).rejects.toThrow("prompt must not be empty");
    await expect(launchFlySandboxRun({
      bundle: bundle(), prompt: "prompt", jsonSchema, claudeCodeOAuthToken: " ", config,
    }, { flyClient })).rejects.toThrow("claudeCodeOAuthToken must not be empty");
    expect(launches).toBe(0);
  });

  it("rejects a bundle collision with the reserved prompt path", async () => {
    await expect(launchFlySandboxRun({
      bundle: bundle({
        "input/prompt.md": { content: "forged", sha256: "3".repeat(64), bytes: 6 },
      }),
      prompt: "real prompt",
      jsonSchema,
      claudeCodeOAuthToken: "token",
      config,
    }, {
      flyClient: { create: async () => ({ id: "unexpected", state: "created" }) },
    })).rejects.toThrow("reserved prompt path");
  });

  it("rejects a bundle collision with the reserved output schema path", async () => {
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
    }, {
      flyClient: { create: async () => ({ id: "unexpected", state: "created" }) },
    })).rejects.toThrow("reserved output schema path");
  });
});

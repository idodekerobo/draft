import { randomUUID } from "node:crypto";
import type { AgentRunSpec } from "draft-core/run-spec";
import { createAgentRunToken } from "../metaharness/runs/run-token";
import { createSandboxCallbackToken } from "./callback-token";
import { uploadRunBundle, type UploadedBundle } from "./bundle-storage";
import {
  FlyMachinesClient,
  FlyMachineWaitTimeoutError,
  type CreateFlyMachineInput,
  type FlyMachine,
  type FlyMachineState,
  type WaitForStateOptions,
} from "./fly-machines";
import {
  type SandboxDeploymentConfig,
  validateSandboxDeploymentConfig,
} from "./config";
import { buildRunnerManifest, legacyRunnerEnv, needsDraftToolServer, type PromptSource } from "./run-manifest";

const PROMPT_PATH = "input/prompt.md";
const OUTPUT_SCHEMA_PATH = "input/output-schema.json";
const SANDBOX_TIMEOUT_SECONDS = 20 * 60;
const CALLBACK_TOKEN_TTL_MS = 30 * 60 * 1_000;
const BOOT_TIMEOUT_MS = 60_000;
const SANDBOX_GUEST = {
  cpu_kind: "shared" as const,
  cpus: 1,
  memory_mb: 1024,
};

// Narrowed subset of ValidatedRunBundle so non-synthesis callers (e.g.
// summarization) don't depend on synthesis's bundle-building internals.
export interface SandboxRunBundle {
  organizationId: string;
  workspaceId: string;
  runId: string;
  bundleHash: string;
  files: Record<string, { content: string }>;
}

/** The secret the harness signs in with. It goes to the machine in its own variable and never into the manifest. */
export type SandboxCredentials = { claudeCodeOAuthToken: string } | { codexAuthJson: string };

export interface LaunchFlySandboxRunInput {
  /** What the run is. The harness, model, tools and output kind all come from it. A sandbox run is a cloud run. */
  spec: AgentRunSpec;
  bundle: SandboxRunBundle;
  /** One prompt for the run, or a bundle file that lists a prompt file per item. */
  prompt: PromptSource;
  credentials: SandboxCredentials;
  config: SandboxDeploymentConfig;
  /** Runner wall-clock limit. Defaults to the shared sandbox timeout. */
  timeoutSeconds?: number;
}

function serializeJsonSchema(schema: Record<string, unknown>): string {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("jsonSchema must be a JSON object");
  }
  const serialized = JSON.stringify(schema, (_key, value: unknown) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
  });
  if (!serialized) throw new Error("jsonSchema must be a JSON object");
  return serialized;
}

export interface FlySandboxRunClient {
  create(input: CreateFlyMachineInput): Promise<FlyMachine>;
  waitForState(
    machineId: string,
    desiredState: FlyMachineState,
    options?: WaitForStateOptions,
  ): Promise<FlyMachine>;
  forceDelete(machineId: string): Promise<void>;
}

export type BundleUploader = (input: {
  organizationId: string;
  workspaceId: string;
  runId: string;
  files: Record<string, string>;
}) => Promise<UploadedBundle>;

export interface LaunchFlySandboxRunDependencies {
  flyClient?: FlySandboxRunClient;
  bundleUploader?: BundleUploader;
  now?: () => number;
  nonce?: () => string;
}

export interface FlySandboxRunReceipt {
  machineId: string;
  state: string;
  runId: string;
  bundleHash: string;
  callbackExpiresAt: number;
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be empty`);
}

/**
 * Launch one isolated, one-shot Fly Machine for a previously validated bundle.
 * Persistence and run state transitions deliberately live outside this boundary.
 */
export async function launchFlySandboxRun(
  input: LaunchFlySandboxRunInput,
  dependencies: LaunchFlySandboxRunDependencies = {},
): Promise<FlySandboxRunReceipt> {
  const { spec } = input;
  if (input.prompt.kind === "text") assertNonEmpty(input.prompt.text, "prompt");
  const claudeToken = "claudeCodeOAuthToken" in input.credentials ? input.credentials.claudeCodeOAuthToken : undefined;
  const codexAuthJson = "codexAuthJson" in input.credentials ? input.credentials.codexAuthJson : undefined;
  if (spec.harness === "codex") assertNonEmpty(codexAuthJson ?? "", "codexAuthJson");
  else assertNonEmpty(claudeToken ?? "", "claudeCodeOAuthToken");
  const config = validateSandboxDeploymentConfig(input.config);

  if (Object.hasOwn(input.bundle.files, PROMPT_PATH)) {
    throw new Error(`Run bundle already contains reserved prompt path: ${PROMPT_PATH}`);
  }
  const structured = spec.output.type === "structured";
  if (structured && Object.hasOwn(input.bundle.files, OUTPUT_SCHEMA_PATH)) {
    throw new Error(`Run bundle already contains reserved output schema path: ${OUTPUT_SCHEMA_PATH}`);
  }
  const serializedSchema = spec.output.type === "structured" ? serializeJsonSchema(spec.output.schema as Record<string, unknown>) : null;

  const now = dependencies.now ?? Date.now;
  const nonce = dependencies.nonce ?? randomUUID;
  const callbackExpiresAt = now() + CALLBACK_TOKEN_TTL_MS;
  const callbackToken = createSandboxCallbackToken(
    {
      runId: input.bundle.runId,
      bundleHash: input.bundle.bundleHash,
      expiresAt: callbackExpiresAt,
      nonce: nonce(),
    },
    config.callbackSecret,
  );

  // Same host as the callback, which the sandbox is already allowed to reach.
  const draftMcpUrl = needsDraftToolServer(spec) ? new URL(`/runs/${spec.id}/mcp`, config.callbackUrl).toString() : null;
  const manifest = buildRunnerManifest({
    spec,
    callbackUrl: config.callbackUrl,
    prompt: input.prompt,
    timeoutSeconds: input.timeoutSeconds ?? SANDBOX_TIMEOUT_SECONDS,
    draftMcpUrl,
  });

  const filesForUpload = Object.fromEntries(
    Object.entries(input.bundle.files).map(([path, file]) => [path, file.content]),
  );
  if (input.prompt.kind === "text") filesForUpload[PROMPT_PATH] = input.prompt.text;
  if (serializedSchema !== null) filesForUpload[OUTPUT_SCHEMA_PATH] = `${serializedSchema}\n`;

  const bundleUploader = dependencies.bundleUploader ?? uploadRunBundle;
  const uploaded = await bundleUploader({
    organizationId: input.bundle.organizationId,
    workspaceId: input.bundle.workspaceId,
    runId: input.bundle.runId,
    files: filesForUpload,
  });
  const storageHost = new URL(config.supabaseUrl).hostname;

  const client: FlySandboxRunClient =
    dependencies.flyClient ??
    new FlyMachinesClient({
      app: config.flyAppName,
      token: config.flyApiToken,
    });
  const env: Record<string, string> = {
    DRAFT_RUN_ID: input.bundle.runId,
    DRAFT_BUNDLE_HASH: input.bundle.bundleHash,
    DRAFT_BUNDLE_URL: uploaded.signedUrl,
    DRAFT_EGRESS_HOSTS: storageHost,
    DRAFT_CALLBACK_URL: config.callbackUrl,
    DRAFT_CALLBACK_TOKEN: callbackToken,
    DRAFT_PROMPT_PATH: `/run/${PROMPT_PATH}`,
    DRAFT_TIMEOUT_SECONDS: String(manifest.timeoutSeconds),
    DRAFT_RUN_MANIFEST: JSON.stringify(manifest),
    ...legacyRunnerEnv(manifest),
  };
  if (spec.harness === "codex") env.CODEX_AUTH_JSON = codexAuthJson!;
  else env.CLAUDE_CODE_OAUTH_TOKEN = claudeToken!;
  if (draftMcpUrl) {
    env.DRAFT_RUN_TOKEN = createAgentRunToken(
      { runId: spec.id, workspaceId: spec.workspaceId, expiresAt: callbackExpiresAt, nonce: nonce() },
      config.callbackSecret,
    );
  }
  const created = await client.create({
    image: config.flySandboxImage,
    files: {},
    region: config.flyRegion,
    guest: SANDBOX_GUEST,
    metadata: {
      run_id: input.bundle.runId,
      bundle_hash: input.bundle.bundleHash,
    },
    env,
  });

  let machine: FlyMachine;
  try {
    machine = await client.waitForState(created.id, "started", {
      timeoutMs: BOOT_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof FlyMachineWaitTimeoutError) {
      await client.forceDelete(created.id).catch(() => undefined);
    }
    throw error;
  }

  return {
    machineId: machine.id,
    state: machine.state,
    runId: input.bundle.runId,
    bundleHash: input.bundle.bundleHash,
    callbackExpiresAt,
  };
}

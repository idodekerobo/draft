import { randomUUID } from "node:crypto";
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

const PROMPT_PATH = "input/prompt.md";
const OUTPUT_SCHEMA_PATH = "input/output-schema.json";
const SANDBOX_TIMEOUT_SECONDS = 20 * 60;
const CALLBACK_TOKEN_TTL_MS = 30 * 60 * 1_000;
const BOOT_TIMEOUT_MS = 60_000;
const SANDBOX_GUEST = {
  cpu_kind: "shared" as const,
  cpus: 1,
  memory_mb: 512,
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

export interface LaunchFlySandboxRunInput {
  bundle: SandboxRunBundle;
  /** Required unless mode is "batch" -- batch runs carry per-session prompts in the bundle instead. */
  prompt?: string;
  jsonSchema: Record<string, unknown>;
  claudeCodeOAuthToken: string;
  config: SandboxDeploymentConfig;
  /** Additive: omitted preserves today's single-prompt runner behavior. */
  mode?: "single" | "batch";
  /** Bundle-relative manifest path, required when mode is "batch". */
  manifestPath?: string;
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
  if (input.mode !== "batch") assertNonEmpty(input.prompt ?? "", "prompt");
  assertNonEmpty(input.claudeCodeOAuthToken, "claudeCodeOAuthToken");
  const config = validateSandboxDeploymentConfig(input.config);

  if (Object.hasOwn(input.bundle.files, PROMPT_PATH)) {
    throw new Error(`Run bundle already contains reserved prompt path: ${PROMPT_PATH}`);
  }
  if (Object.hasOwn(input.bundle.files, OUTPUT_SCHEMA_PATH)) {
    throw new Error(`Run bundle already contains reserved output schema path: ${OUTPUT_SCHEMA_PATH}`);
  }
  const serializedSchema = serializeJsonSchema(input.jsonSchema);

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

  const filesForUpload = Object.fromEntries(
    Object.entries(input.bundle.files).map(([path, file]) => [path, file.content]),
  );
  if (input.prompt !== undefined) filesForUpload[PROMPT_PATH] = input.prompt;
  filesForUpload[OUTPUT_SCHEMA_PATH] = `${serializedSchema}\n`;

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
    CLAUDE_CODE_OAUTH_TOKEN: input.claudeCodeOAuthToken,
    DRAFT_PROMPT_PATH: `/run/${PROMPT_PATH}`,
    DRAFT_OUTPUT_SCHEMA_PATH: `/run/${OUTPUT_SCHEMA_PATH}`,
    DRAFT_TIMEOUT_SECONDS: String(SANDBOX_TIMEOUT_SECONDS),
  };
  if (input.mode === "batch") {
    if (!input.manifestPath) {
      throw new Error("manifestPath is required when mode is \"batch\"");
    }
    env.DRAFT_RUN_MODE = "batch";
    env.DRAFT_MANIFEST_PATH = `/run/${input.manifestPath}`;
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

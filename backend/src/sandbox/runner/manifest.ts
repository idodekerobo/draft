import { parseRunnerManifest, type RunnerManifest } from "draft-core/run-manifest";

export function parseTimeoutSeconds(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 300;
  if (!/^\d+$/.test(raw)) throw new Error("DRAFT_TIMEOUT_SECONDS must be an integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 3600) {
    throw new Error("DRAFT_TIMEOUT_SECONDS must be between 1 and 3600");
  }
  return value;
}

export function loadRunnerManifest(env: NodeJS.ProcessEnv, callbackUrl: string): RunnerManifest {
  if (!env.DRAFT_RUN_MANIFEST) throw new Error("DRAFT_RUN_MANIFEST is required");
  return parseRunnerManifest(env.DRAFT_RUN_MANIFEST, { callbackUrl });
}

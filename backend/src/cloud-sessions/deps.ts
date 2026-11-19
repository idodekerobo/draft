import { serviceClient } from "../db/client";
import { runTokenSecret } from "../metaharness/runs/run-token-secret";
import { loadSandboxDeploymentConfig } from "../metaharness/sandbox/config";
import { providerFor } from "../metaharness/sandbox/providers";
import type { StartCloudSessionDeps } from "./start";

/** The production dependencies of a cloud start. Throws when the sandbox settings are missing or invalid. */
export function productionStartDeps(): StartCloudSessionDeps {
  const config = loadSandboxDeploymentConfig();
  return { client: serviceClient, provider: providerFor(config.provider), config, tokenSecret: runTokenSecret() };
}

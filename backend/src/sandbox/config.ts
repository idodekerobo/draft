import { loadProviderConfig, validateProviderConfig, type SandboxProviderConfig } from "./providers";

const CALLBACK_PATH = "/sandbox/callback";

export interface SandboxDeploymentConfig {
  callbackUrl: string;
  callbackSecret: string;
  supabaseUrl: string;
  /** Where sandboxes run. The settings that belong to one provider live under it. */
  provider: SandboxProviderConfig;
}

export type SandboxEnvironment = Readonly<Record<string, string | undefined>>;

function required(env: SandboxEnvironment, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

export function validateSandboxDeploymentConfig(
  config: SandboxDeploymentConfig,
): SandboxDeploymentConfig {
  for (const [name, value] of Object.entries({ callbackUrl: config.callbackUrl, callbackSecret: config.callbackSecret, supabaseUrl: config.supabaseUrl })) {
    if (value.trim().length === 0) {
      throw new Error(`${name} must not be empty`);
    }
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(config.callbackUrl);
  } catch {
    throw new Error("DRAFT_API_BASE_URL must be a valid HTTPS URL");
  }
  if (callbackUrl.protocol !== "https:") {
    throw new Error("DRAFT_API_BASE_URL must be a valid HTTPS URL");
  }
  const provider = validateProviderConfig(config.provider);

  let supabaseUrl: URL;
  try {
    supabaseUrl = new URL(config.supabaseUrl);
  } catch {
    throw new Error("SUPABASE_URL must be a valid HTTPS URL");
  }
  if (supabaseUrl.protocol !== "https:") {
    throw new Error("SUPABASE_URL must be a valid HTTPS URL");
  }

  return { ...config, provider };
}

/** Load only the configuration needed by the sandbox deployment boundary. */
export function loadSandboxDeploymentConfig(
  env: SandboxEnvironment = process.env,
): SandboxDeploymentConfig {
  const baseUrl = required(env, "DRAFT_API_BASE_URL");
  let callbackUrl: string;
  try {
    callbackUrl = new URL(CALLBACK_PATH, baseUrl).toString();
  } catch {
    throw new Error("DRAFT_API_BASE_URL must be a valid URL");
  }

  return validateSandboxDeploymentConfig({
    callbackUrl,
    callbackSecret: required(env, "SANDBOX_CALLBACK_SECRET"),
    supabaseUrl: required(env, "SUPABASE_URL"),
    provider: loadProviderConfig(env),
  });
}

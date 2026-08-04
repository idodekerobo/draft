const FLY_IMAGE_DIGEST_PATTERN =
  /^registry\.fly\.io\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?@sha256:[0-9a-f]{64}$/;

export interface SandboxDeploymentConfig {
  flyApiToken: string;
  flyAppName: string;
  flySandboxImage: string;
  flyRegion: string;
  callbackUrl: string;
  callbackSecret: string;
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
  for (const [name, value] of Object.entries(config)) {
    if (value.trim().length === 0) {
      throw new Error(`${name} must not be empty`);
    }
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(config.callbackUrl);
  } catch {
    throw new Error("SANDBOX_CALLBACK_URL must be a valid HTTPS URL");
  }
  if (callbackUrl.protocol !== "https:") {
    throw new Error("SANDBOX_CALLBACK_URL must be a valid HTTPS URL");
  }
  if (!FLY_IMAGE_DIGEST_PATTERN.test(config.flySandboxImage)) {
    throw new Error(
      "FLY_SANDBOX_IMAGE must be an immutable registry.fly.io image reference with a lowercase SHA-256 digest",
    );
  }

  return { ...config };
}

/** Load only the configuration needed by the Fly sandbox deployment boundary. */
export function loadSandboxDeploymentConfig(
  env: SandboxEnvironment = process.env,
): SandboxDeploymentConfig {
  return validateSandboxDeploymentConfig({
    flyApiToken: required(env, "FLY_API_TOKEN"),
    flyAppName: required(env, "FLY_APP_NAME"),
    flySandboxImage: required(env, "FLY_SANDBOX_IMAGE"),
    flyRegion: required(env, "FLY_REGION"),
    callbackUrl: required(env, "SANDBOX_CALLBACK_URL"),
    callbackSecret: required(env, "SANDBOX_CALLBACK_SECRET"),
  });
}

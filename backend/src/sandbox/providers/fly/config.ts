const FLY_IMAGE_DIGEST_PATTERN = /^registry\.fly\.io\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?@sha256:[0-9a-f]{64}$/;

export interface FlyProviderConfig {
  kind: "fly";
  apiToken: string;
  appName: string;
  image: string;
  region: string;
}

export type FlyEnvironment = Readonly<Record<string, string | undefined>>;

function required(env: FlyEnvironment, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`${name} must not be empty`);
  return value;
}

export function validateFlyConfig(config: FlyProviderConfig): FlyProviderConfig {
  for (const [name, value] of Object.entries(config)) {
    if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
  }
  if (!FLY_IMAGE_DIGEST_PATTERN.test(config.image)) {
    throw new Error("FLY_SANDBOX_IMAGE must be an immutable registry.fly.io image reference with a lowercase SHA-256 digest");
  }
  return { ...config };
}

export function loadFlyConfig(env: FlyEnvironment): FlyProviderConfig {
  return validateFlyConfig({
    kind: "fly",
    apiToken: required(env, "FLY_API_TOKEN"),
    appName: required(env, "FLY_APP_NAME"),
    image: required(env, "FLY_SANDBOX_IMAGE"),
    region: required(env, "FLY_REGION"),
  });
}

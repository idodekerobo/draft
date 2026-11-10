import { loadFlyConfig, validateFlyConfig, type FlyEnvironment, type FlyProviderConfig } from "./fly/config";
import { createFlyProvider } from "./fly/provider";
import type { SandboxProvider } from "./types";

/** The settings of the provider a deployment uses. A new provider adds a case here. */
export type SandboxProviderConfig = FlyProviderConfig;

export function providerFor(config: SandboxProviderConfig): SandboxProvider {
  switch (config.kind) {
    case "fly":
      return createFlyProvider(config);
  }
}

export function validateProviderConfig(config: SandboxProviderConfig): SandboxProviderConfig {
  switch (config.kind) {
    case "fly":
      return validateFlyConfig(config);
  }
}

/** Reads the provider settings from the environment. Fly is the only provider today. */
export function loadProviderConfig(env: FlyEnvironment): SandboxProviderConfig {
  return loadFlyConfig(env);
}

export type { SandboxPlan, SandboxProvider, SandboxStart } from "./types";

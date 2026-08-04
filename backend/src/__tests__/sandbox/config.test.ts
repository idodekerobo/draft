import { describe, expect, it } from "bun:test";
import {
  loadSandboxDeploymentConfig,
  validateSandboxDeploymentConfig,
} from "../../sandbox/config";

const digest = `registry.fly.io/draft@sha256:${"a".repeat(64)}`;
const environment = {
  FLY_API_TOKEN: "fly-token",
  FLY_APP_NAME: "draft-sandbox",
  FLY_SANDBOX_IMAGE: digest,
  FLY_REGION: "iad",
  SANDBOX_CALLBACK_URL: "https://api.example.test/sandbox/callback",
  SANDBOX_CALLBACK_SECRET: "signing-secret",
};

describe("sandbox deployment config", () => {
  it("loads an isolated deployment config from an injected environment", () => {
    expect(loadSandboxDeploymentConfig(environment)).toEqual({
      flyApiToken: "fly-token",
      flyAppName: "draft-sandbox",
      flySandboxImage: digest,
      flyRegion: "iad",
      callbackUrl: "https://api.example.test/sandbox/callback",
      callbackSecret: "signing-secret",
    });
  });

  it("requires every sandbox environment variable", () => {
    for (const name of Object.keys(environment)) {
      expect(() => loadSandboxDeploymentConfig({ ...environment, [name]: " " }))
        .toThrow(`${name} must not be empty`);
    }
  });

  it("rejects non-HTTPS callback URLs", () => {
    expect(() => loadSandboxDeploymentConfig({
      ...environment,
      SANDBOX_CALLBACK_URL: "http://api.example.test/callback",
    })).toThrow("valid HTTPS URL");
  });

  it("rejects mutable, malformed, and uppercase image digests", () => {
    for (const flySandboxImage of [
      "registry.fly.io/draft:latest",
      "registry.fly.io/draft:LATEST",
      "registry.fly.io/draft:version-1",
      "registry.fly.io/draft",
      "draft:version-1",
      `registry.fly.io/team/draft@sha256:${"a".repeat(64)}`,
      `registry.fly.io/Draft@sha256:${"a".repeat(64)}`,
      "registry.fly.io/draft@sha256:abc",
      `registry.fly.io/draft@sha256:${"A".repeat(64)}`,
      `${digest}:latest`,
    ]) {
      expect(() => validateSandboxDeploymentConfig({
        ...loadSandboxDeploymentConfig(environment),
        flySandboxImage,
      })).toThrow("immutable registry.fly.io image reference");
    }
  });

  it("does not include a rejected image reference in its validation error", () => {
    const rejectedReference = "registry.fly.io/draft:secret-deployment-label";
    let validationError: unknown;
    try {
      validateSandboxDeploymentConfig({
        ...loadSandboxDeploymentConfig(environment),
        flySandboxImage: rejectedReference,
      });
    } catch (error) {
      validationError = error;
    }
    expect(validationError).toBeInstanceOf(Error);
    expect(String(validationError)).not.toContain(rejectedReference);
  });
});

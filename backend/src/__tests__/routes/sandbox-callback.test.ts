import { beforeAll, describe, expect, it, mock } from "bun:test";

const digest = `registry.fly.io/draft@sha256:${"a".repeat(64)}`;

// loadSandboxDeploymentConfig() (called with no arguments by the route) reads
// straight from process.env, so the required sandbox env vars must be present
// before the route module is imported.
beforeAll(() => {
  process.env.FLY_API_TOKEN = "fly-token";
  process.env.FLY_APP_NAME = "draft-sandbox";
  process.env.FLY_SANDBOX_IMAGE = digest;
  process.env.FLY_REGION = "iad";
  process.env.API_BASE_URL = "https://api.example.test";
  process.env.SANDBOX_CALLBACK_SECRET = "signing-secret";
});

function callbackRequest(): Request {
  return new Request("http://internal.test/sandbox/callback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run_id: "run-1", bundle_hash: "a".repeat(64), result: {} }),
  });
}

describe("POST /sandbox/callback", () => {
  it("returns 401 (no leaked detail) when completeSynthesisRunCallback throws SandboxCallbackRequestError", async () => {
    const { SandboxCallbackRequestError } = await import("../../sandbox/callback-request");

    mock.module("../../synthesis/orchestrate-run", () => ({
      completeSynthesisRunCallback: async () => {
        throw new SandboxCallbackRequestError("Callback authentication failed");
      },
    }));

    const { POST } = await import("../../routes/sandbox-callback");
    const response = await POST(callbackRequest());

    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain("Callback authentication failed");
  });

  it("returns 500 (no leaked detail) when completeSynthesisRunCallback throws an unexpected error", async () => {
    mock.module("../../synthesis/orchestrate-run", () => ({
      completeSynthesisRunCallback: async () => {
        throw new Error("db connection refused at 10.0.0.5:5432 with credentials xyz");
      },
    }));

    // Re-import after re-mocking; Bun's module registry serves the latest
    // mock.module factory registered for this specifier.
    const routeModule = await import("../../routes/sandbox-callback");
    const response = await routeModule.POST(callbackRequest());

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("db connection refused");
    expect(text).not.toContain("10.0.0.5");
  });

  it("returns whatever completeSynthesisRunCallback returns on success", async () => {
    mock.module("../../synthesis/orchestrate-run", () => ({
      completeSynthesisRunCallback: async () => new Response(null, { status: 204 }),
    }));

    const routeModule = await import("../../routes/sandbox-callback");
    const response = await routeModule.POST(callbackRequest());

    expect(response.status).toBe(204);
  });

  it("returns 500 with no leaked detail when required sandbox env vars are missing", async () => {
    mock.module("../../synthesis/orchestrate-run", () => ({
      completeSynthesisRunCallback: async () => new Response(null, { status: 204 }),
    }));

    const previous = process.env.SANDBOX_CALLBACK_SECRET;
    delete process.env.SANDBOX_CALLBACK_SECRET;
    try {
      const routeModule = await import("../../routes/sandbox-callback");
      const response = await routeModule.POST(callbackRequest());
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("SANDBOX_CALLBACK_SECRET");
    } finally {
      process.env.SANDBOX_CALLBACK_SECRET = previous;
    }
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createIntegrationOutput } from "../integrations/safe-output.ts";
import { runLinearConnect, type LinearConnectDeps } from "../integrations/providers/linear.ts";
import { runClaudeCodeConnect, type ClaudeCodeConnectDeps } from "../integrations/providers/claude-code.ts";
import {
  CredentialInputError,
  type CredentialReader,
  type CredentialSource,
  type ProviderCredentials,
} from "../integrations/credentials.ts";
import { createMockBackend } from "./helpers/mock-backend.ts";
import { makeHome, runCli, seedCliAuth } from "./helpers/cli-runner.ts";

function output(json: boolean) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    value: createIntegrationOutput({
      json,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    }),
  };
}

const ttySource: CredentialSource = { kind: "tty" };

function stubReader<P extends "linear" | "claude-code">(
  provider: P,
  read: () => Promise<ProviderCredentials[P]>,
  preflightTty: () => Promise<boolean> = async () => true,
): CredentialReader {
  return {
    preflightTty,
    read: (async (requested: P) => {
      if (requested !== provider) throw new Error(`unexpected provider ${requested}`);
      return read();
    }) as CredentialReader["read"],
  };
}

describe("Linear connect provider", () => {
  it("emits awaiting_credentials then connected on success", async () => {
    const connectCalls: unknown[] = [];
    const deps: LinearConnectDeps = {
      reader: stubReader("linear", async () => ({ api_key: "lin_api_secret" })),
      connect: async (body) => { connectCalls.push(body); return { ok: true, value: { ok: true } }; },
    };
    const rendered = output(true);
    expect(await runLinearConnect({ source: ttySource }, rendered.value, deps)).toBe(0);
    expect(connectCalls).toEqual([{ provider: "linear", api_token: "lin_api_secret" }]);
    expect(rendered.stdout.map((line) => JSON.parse(line))).toEqual([
      { schema_version: 1, status: "awaiting_credentials", provider: "linear" },
      { schema_version: 1, status: "connected", provider: "linear" },
    ]);
  });

  it("reports cleanup_pending and warns without leaking it into the JSONL success line's shape", async () => {
    const deps: LinearConnectDeps = {
      reader: stubReader("linear", async () => ({ api_key: "lin_api_secret" })),
      connect: async () => ({ ok: true, value: { ok: true, cleanup_pending: true } }),
    };
    const rendered = output(true);
    expect(await runLinearConnect({ source: ttySource }, rendered.value, deps)).toBe(0);
    expect(rendered.stdout.at(-1)).toBe(`${JSON.stringify({ schema_version: 1, status: "connected", provider: "linear", cleanup_pending: true })}\n`);
    expect(rendered.stderr).toEqual(["Warning: a previous Linear webhook could not be removed automatically; cleanup will retry.\n"]);
  });

  it("prints the cleanup warning in human mode too", async () => {
    const deps: LinearConnectDeps = {
      reader: stubReader("linear", async () => ({ api_key: "lin_api_secret" })),
      connect: async () => ({ ok: true, value: { ok: true, cleanup_pending: true } }),
    };
    const rendered = output(false);
    expect(await runLinearConnect({ source: ttySource }, rendered.value, deps)).toBe(0);
    expect(rendered.stdout.join("")).toBe("Linear: connected\n");
    expect(rendered.stderr.join("")).toContain("Warning: a previous Linear webhook could not be removed automatically");
  });

  it("never renders the raw api_key, even on a canary-secret failure path", async () => {
    const deps: LinearConnectDeps = {
      reader: stubReader("linear", async () => ({ api_key: "canary-secret-value" })),
      connect: async () => ({ ok: false, code: "linear_webhook_create_failed" }),
    };
    const rendered = output(true);
    expect(await runLinearConnect({ source: ttySource }, rendered.value, deps)).toBe(1);
    expect(rendered.stdout.join("")).not.toContain("canary-secret-value");
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "linear_webhook_create_failed" });
  });

  it("maps credential input failures without calling connect", async () => {
    let connectCalled = false;
    const deps: LinearConnectDeps = {
      reader: { preflightTty: async () => false, read: async () => { throw new CredentialInputError("credential_input_required"); } },
      connect: async () => { connectCalled = true; return { ok: true, value: { ok: true } }; },
    };
    const rendered = output(true);
    expect(await runLinearConnect({ source: ttySource }, rendered.value, deps)).toBe(2);
    expect(connectCalled).toBe(false);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "credential_input_required" });
  });
});

describe("Claude Code connect provider", () => {
  it("reports credential_stored, not connected, on success", async () => {
    const connectCalls: unknown[] = [];
    const deps: ClaudeCodeConnectDeps = {
      reader: stubReader("claude-code", async () => ({ setup_token: "setup_secret" })),
      connect: async (body) => { connectCalls.push(body); return { ok: true, value: { ok: true } }; },
    };
    const rendered = output(true);
    expect(await runClaudeCodeConnect({ source: ttySource }, rendered.value, deps)).toBe(0);
    expect(connectCalls).toEqual([{ provider: "claude_code", token: "setup_secret" }]);
    expect(rendered.stdout.map((line) => JSON.parse(line))).toEqual([
      { schema_version: 1, status: "awaiting_credentials", provider: "claude-code" },
      { schema_version: 1, status: "credential_stored", provider: "claude-code" },
    ]);
  });

  it("never renders the raw setup token", async () => {
    const deps: ClaudeCodeConnectDeps = {
      reader: stubReader("claude-code", async () => ({ setup_token: "canary-setup-token" })),
      connect: async () => ({ ok: false, code: "request_failed" }),
    };
    const rendered = output(true);
    expect(await runClaudeCodeConnect({ source: ttySource }, rendered.value, deps)).toBe(1);
    expect(rendered.stdout.join("")).not.toContain("canary-setup-token");
  });
});

describe("draft integrations connect linear / claude-code", () => {
  let backend: ReturnType<typeof createMockBackend>;
  let home: string;

  beforeEach(() => {
    backend = createMockBackend();
    home = makeHome();
    seedCliAuth(home);
  });

  afterEach(() => backend.stop());

  it("connects linear end-to-end through --credential-stdin", async () => {
    const result = await runCli(["integrations", "connect", "linear", "--credential-stdin", "--json"], {
      home,
      apiUrl: backend.url,
      stdin: JSON.stringify({ api_key: "lin_api_e2e" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n").map((line) => JSON.parse(line))).toEqual([
      { schema_version: 1, status: "awaiting_credentials", provider: "linear" },
      { schema_version: 1, status: "connected", provider: "linear" },
    ]);
    const connectRequest = backend.state.requests.find((request) =>
      request.method === "POST" && new URL(request.url).pathname.endsWith("/connections")
    );
    expect(connectRequest && JSON.parse(connectRequest.body)).toEqual({ provider: "linear", api_token: "lin_api_e2e" });
  });

  it("connects claude-code end-to-end through --credential-stdin", async () => {
    const result = await runCli(["integrations", "connect", "claude-code", "--credential-stdin", "--json"], {
      home,
      apiUrl: backend.url,
      stdin: JSON.stringify({ setup_token: "setup_e2e" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n").map((line) => JSON.parse(line))).toEqual([
      { schema_version: 1, status: "awaiting_credentials", provider: "claude-code" },
      { schema_version: 1, status: "credential_stored", provider: "claude-code" },
    ]);
    const connectRequest = backend.state.requests.find((request) =>
      request.method === "POST" && new URL(request.url).pathname.endsWith("/connections")
    );
    expect(connectRequest && JSON.parse(connectRequest.body)).toEqual({ provider: "claude_code", token: "setup_e2e" });
  });

  it("never leaks the secret if the backend returns malformed JSON", async () => {
    backend.state.connectionsConnectResponse = () => new Response("not json{{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const result = await runCli(["integrations", "connect", "linear", "--credential-stdin", "--json"], {
      home,
      apiUrl: backend.url,
      stdin: JSON.stringify({ api_key: "canary-malformed-secret" }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("canary-malformed-secret");
    expect(result.stderr).not.toContain("canary-malformed-secret");
    expect(JSON.parse(result.stdout.trim().split("\n").at(-1)!)).toMatchObject({ status: "error", code: "malformed_response" });
  });

  it("rejects invalid grammar before any request", async () => {
    const cases = [
      ["integrations", "connect", "linear", "extra"],
      ["integrations", "connect", "linear", "--json", "--json"],
      ["integrations", "connect", "linear", "--no-open"],
      ["integrations", "connect", "linear", "--credential-stdin", "--credential-fd", "3"],
      ["integrations", "connect", "claude-code", "extra"],
      ["integrations", "connect", "claude-code", "--no-open"],
    ];
    for (const args of cases) {
      const result = await runCli(args, { home, apiUrl: backend.url });
      expect(result.exitCode).toBe(2);
    }
    expect(backend.state.requests).toEqual([]);
  });

  it("disconnects claude-code deterministically as not_supported without a network call", async () => {
    const result = await runCli(["integrations", "disconnect", "claude-code", "--json"], {
      home,
      apiUrl: backend.url,
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ status: "error", code: "not_supported" });
    expect(backend.state.requests).toEqual([]);
  });
});

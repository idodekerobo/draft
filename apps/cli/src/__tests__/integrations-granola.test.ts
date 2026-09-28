import { describe, expect, it } from "bun:test";
import { createIntegrationOutput } from "../integrations/safe-output.ts";
import { runGranolaConnect, type GranolaConnectDeps } from "../integrations/providers/granola.ts";
import {
  type CredentialReader,
  type CredentialSource,
  type ProviderCredentials,
} from "../integrations/credentials.ts";

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
const noopExit = { exitProcess: () => {} };

function stubReader(read: () => Promise<ProviderCredentials["granola"]>): CredentialReader {
  return {
    preflightTty: async () => true,
    read: (async (requested: "granola") => {
      if (requested !== "granola") throw new Error(`unexpected provider ${requested}`);
      return read();
    }) as CredentialReader["read"],
  };
}

describe("Granola connect provider", () => {
  it("emits awaiting_credentials then connected on success, defaulting to a personal key", async () => {
    const connectCalls: unknown[] = [];
    const deps: GranolaConnectDeps = {
      reader: stubReader(async () => ({ api_token: "grn_secret" })),
      connect: async (body) => { connectCalls.push(body); return { ok: true, value: { ok: true } }; },
      ...noopExit,
    };
    const rendered = output(true);
    expect(await runGranolaConnect({ source: ttySource, accountKind: "personal" }, rendered.value, deps)).toBe(0);
    expect(connectCalls).toEqual([{ provider: "granola", api_token: "grn_secret", account_kind: "personal" }]);
    expect(rendered.stdout.map((line) => JSON.parse(line))).toEqual([
      { schema_version: 1, status: "awaiting_credentials", provider: "granola" },
      { schema_version: 1, status: "connected", provider: "granola" },
    ]);
  });

  it("passes account_kind through as workspace when requested", async () => {
    const connectCalls: unknown[] = [];
    const deps: GranolaConnectDeps = {
      reader: stubReader(async () => ({ api_token: "grn_ws_secret" })),
      connect: async (body) => { connectCalls.push(body); return { ok: true, value: { ok: true } }; },
      ...noopExit,
    };
    const rendered = output(true);
    expect(await runGranolaConnect({ source: ttySource, accountKind: "workspace" }, rendered.value, deps)).toBe(0);
    expect(connectCalls).toEqual([{ provider: "granola", api_token: "grn_ws_secret", account_kind: "workspace" }]);
  });

  it("surfaces a connect failure from the backend (e.g. a duplicate-account rejection) as exit code 1", async () => {
    let connectCallCount = 0;
    const deps: GranolaConnectDeps = {
      reader: stubReader(async () => ({ api_token: "grn_secret" })),
      connect: async () => {
        connectCallCount += 1;
        return { ok: false, code: "request_failed" };
      },
      ...noopExit,
    };
    const rendered = output(true);
    const exitCode = await runGranolaConnect({ source: ttySource, accountKind: "personal" }, rendered.value, deps);
    expect(exitCode).toBe(1);
    expect(connectCallCount).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createIntegrationOutput } from "../integrations/safe-output.ts";
import { runFirefliesConnect, type FirefliesConnectDeps } from "../integrations/providers/fireflies.ts";
import { CredentialInputError, type CredentialReader } from "../integrations/credentials.ts";
import type { ttyConfirm, ttyWaitForAck } from "../integrations/tty-prompt.ts";
import type { HostedConnectionTransport } from "../cloud-client.ts";
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

function connectionRow(status: HostedConnectionTransport["status"]): HostedConnectionTransport {
  return {
    provider: "fireflies",
    status,
    display_name: null,
    last_success_at: null,
    last_error_at: null,
  };
}

function harness(overrides: Partial<FirefliesConnectDeps> = {}) {
  const writtenFiles: { path: string; content: string }[] = [];
  const removedDirs: string[] = [];
  const launches: string[] = [];
  const handlers = new Map<string, () => void>();
  let tempDirCounter = 0;

  const deps: FirefliesConnectDeps = {
    reader: {
      preflightTty: async () => true,
      read: (async () => ({ api_token: "ff-secret-value" })) as CredentialReader["read"],
    },
    launcher: { launchBrowser: async (url) => { launches.push(url); return { opened: true }; } },
    listConnections: async () => ({ ok: true, value: { connections: [] } }),
    connect: async () => ({ ok: true, value: { ok: true, webhookUrl: "https://api.example.com/hooks/ff/abc", webhookSecret: "ff-webhook-secret-canary" } }),
    confirm: (async () => "yes") as typeof ttyConfirm,
    waitForAck: (async () => "acked") as typeof ttyWaitForAck,
    ackTimeoutMs: 600_000,
    onSignal: (signal, handler) => { handlers.set(signal, handler); },
    offSignal: (signal) => { handlers.delete(signal); },
    mkTempDir: () => `/tmp/draft-fireflies-test-${tempDirCounter++}`,
    writeFile: (path, content) => { writtenFiles.push({ path, content }); },
    removeDir: (path) => { removedDirs.push(path); },
    ...overrides,
  };
  return { deps, writtenFiles, removedDirs, launches, handlers };
}

describe("Fireflies connect provider", () => {
  it("requires a tty before any request — no listConnections, no connect", async () => {
    let listCalled = false;
    let connectCalled = false;
    const h = harness({
      reader: { preflightTty: async () => false, read: (async () => { throw new Error("must-not-be-called"); }) as CredentialReader["read"] },
      listConnections: async () => { listCalled = true; return { ok: true, value: { connections: [] } }; },
      connect: async () => { connectCalled = true; return { ok: true, value: { ok: true, webhookUrl: "u", webhookSecret: "s" } }; },
    });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: true }, rendered.value, h.deps)).toBe(2);
    expect(listCalled).toBe(false);
    expect(connectCalled).toBe(false);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "credential_input_required" });
  });

  it("writes the handoff page, opens the browser, and reports credentials_stored_webhook_pending", async () => {
    const h = harness();
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: false }, rendered.value, h.deps)).toBe(0);
    const lines = rendered.stdout.map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ status: "handoff_required", provider: "fireflies", opened: true });
    expect(lines[0].url).toMatch(/^file:\/\/\/tmp\/draft-fireflies-test-0\/index\.html$/);
    expect(lines.at(-1)).toEqual({ schema_version: 1, status: "credentials_stored_webhook_pending", provider: "fireflies" });
    expect(h.writtenFiles).toHaveLength(1);
    expect(h.writtenFiles[0]!.content).toContain("https://api.example.com/hooks/ff/abc");
    expect(h.writtenFiles[0]!.content).toContain("ff-webhook-secret-canary");
    expect(h.launches).toEqual(["file:///tmp/draft-fireflies-test-0/index.html"]);
    expect(h.removedDirs).toEqual(["/tmp/draft-fireflies-test-0"]);
  });

  it("never renders the raw api_token or webhook secret to stdout/stderr", async () => {
    const rendered = output(true);
    const h = harness();
    expect(await runFirefliesConnect({ noOpen: false }, rendered.value, h.deps)).toBe(0);
    const allOutput = rendered.stdout.join("") + rendered.stderr.join("");
    expect(allOutput).not.toContain("ff-secret-value");
    expect(allOutput).not.toContain("ff-webhook-secret-canary");
  });

  it("falls back to printing the file path when --no-open is set (no browser launch)", async () => {
    const h = harness();
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: true }, rendered.value, h.deps)).toBe(0);
    expect(h.launches).toEqual([]);
    const handoff = JSON.parse(rendered.stdout[0]!);
    expect(handoff).toMatchObject({ status: "handoff_required", opened: false });
  });

  it("falls back to the file path when the browser launcher reports it could not open", async () => {
    const h = harness({ launcher: { launchBrowser: async () => ({ opened: false }) } });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: false }, rendered.value, h.deps)).toBe(0);
    expect(JSON.parse(rendered.stdout[0]!)).toMatchObject({ status: "handoff_required", opened: false });
  });

  it("warns and requires confirmation before reconnecting an existing connection", async () => {
    let confirmMessage: string | undefined;
    const h = harness({
      listConnections: async () => ({ ok: true, value: { connections: [connectionRow("active")] } }),
      confirm: (async (message: string) => { confirmMessage = message; return "yes"; }) as typeof ttyConfirm,
    });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: true }, rendered.value, h.deps)).toBe(0);
    expect(confirmMessage).toContain("rotates the webhook secret");
  });

  it("does not warn when there is no existing (or only revoked) connection", async () => {
    let confirmCalled = false;
    const h = harness({
      listConnections: async () => ({ ok: true, value: { connections: [connectionRow("revoked")] } }),
      confirm: (async () => { confirmCalled = true; return "yes"; }) as typeof ttyConfirm,
    });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: true }, rendered.value, h.deps)).toBe(0);
    expect(confirmCalled).toBe(false);
  });

  it("cancels without connecting when the user declines the reconnect warning", async () => {
    let connectCalled = false;
    const h = harness({
      listConnections: async () => ({ ok: true, value: { connections: [connectionRow("active")] } }),
      confirm: (async () => "no") as typeof ttyConfirm,
      connect: async () => { connectCalled = true; return { ok: true, value: { ok: true, webhookUrl: "u", webhookSecret: "s" } }; },
    });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: true }, rendered.value, h.deps)).toBe(1);
    expect(connectCalled).toBe(false);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "cancelled" });
  });

  it("aborts (exit 130) when SIGINT interrupts the reconnect confirmation, without connecting", async () => {
    let connectCalled = false;
    const h = harness({
      listConnections: async () => ({ ok: true, value: { connections: [connectionRow("active")] } }),
      confirm: (async () => "interrupted") as typeof ttyConfirm,
      connect: async () => { connectCalled = true; return { ok: true, value: { ok: true, webhookUrl: "u", webhookSecret: "s" } }; },
    });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: true }, rendered.value, h.deps)).toBe(130);
    expect(connectCalled).toBe(false);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "aborted" });
  });

  it("maps credential read failures without ever connecting", async () => {
    let connectCalled = false;
    const h = harness({
      reader: {
        preflightTty: async () => true,
        read: (async () => { throw new CredentialInputError("interrupted"); }) as CredentialReader["read"],
      },
      connect: async () => { connectCalled = true; return { ok: true, value: { ok: true, webhookUrl: "u", webhookSecret: "s" } }; },
    });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: true }, rendered.value, h.deps)).toBe(130);
    expect(connectCalled).toBe(false);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "interrupted" });
  });

  it("maps a listConnections failure to its safe error code, without connecting", async () => {
    let connectCalled = false;
    const h = harness({
      listConnections: async () => ({ ok: false, code: "request_failed" }),
      connect: async () => { connectCalled = true; return { ok: true, value: { ok: true, webhookUrl: "u", webhookSecret: "s" } }; },
    });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: true }, rendered.value, h.deps)).toBe(1);
    expect(connectCalled).toBe(false);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "request_failed" });
  });

  it("maps a connect failure to its safe error code, without writing or opening the handoff page", async () => {
    const h = harness({ connect: async () => ({ ok: false, code: "request_failed" }) });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: true }, rendered.value, h.deps)).toBe(1);
    expect(h.writtenFiles).toEqual([]);
    expect(h.removedDirs).toEqual([]);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "request_failed" });
  });

  it("cleans up the temp dir when waitForAck times out, and still reports success", async () => {
    const h = harness({ waitForAck: (async () => "timed_out") as typeof ttyWaitForAck });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: true }, rendered.value, h.deps)).toBe(0);
    expect(h.removedDirs).toEqual(["/tmp/draft-fireflies-test-0"]);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toEqual({ schema_version: 1, status: "credentials_stored_webhook_pending", provider: "fireflies" });
  });

  it("cleans up the temp dir when SIGINT interrupts the ack wait, and still reports success (the connection already succeeded)", async () => {
    const h = harness({
      waitForAck: (async (_message, _timeoutMs, signal) => new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve("interrupted"), { once: true });
      })) as typeof ttyWaitForAck,
    });
    const rendered = output(true);
    const pending = runFirefliesConnect({ noOpen: true }, rendered.value, h.deps);
    await Bun.sleep(0);
    h.handlers.get("SIGINT")?.();
    expect(await pending).toBe(0);
    expect(h.removedDirs).toEqual(["/tmp/draft-fireflies-test-0"]);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toEqual({ schema_version: 1, status: "credentials_stored_webhook_pending", provider: "fireflies" });
  });

  it("cleans up the temp dir even if the browser launcher throws", async () => {
    const h = harness({ launcher: { launchBrowser: async () => { throw new Error("spawn failed"); } } });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: false }, rendered.value, h.deps)).toBe(0);
    expect(h.removedDirs).toEqual(["/tmp/draft-fireflies-test-0"]);
    expect(JSON.parse(rendered.stdout[0]!)).toMatchObject({ status: "handoff_required", opened: false });
  });

  it("maps a malformed connect response (missing webhook fields) to malformed_response", async () => {
    const h = harness({ connect: async () => ({ ok: true, value: { ok: true } }) });
    const rendered = output(true);
    expect(await runFirefliesConnect({ noOpen: true }, rendered.value, h.deps)).toBe(1);
    expect(h.writtenFiles).toEqual([]);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "malformed_response" });
  });
});

describe("draft integrations connect fireflies", () => {
  let backend: ReturnType<typeof createMockBackend>;
  let home: string;

  beforeEach(() => {
    backend = createMockBackend();
    home = makeHome();
    seedCliAuth(home);
  });

  afterEach(() => backend.stop());

  it("rejects invalid grammar before any request", async () => {
    const cases = [
      ["integrations", "connect", "fireflies", "extra"],
      ["integrations", "connect", "fireflies", "--json", "--json"],
      ["integrations", "connect", "fireflies", "--no-open", "--no-open"],
      ["integrations", "connect", "fireflies", "--credential-stdin"],
      ["integrations", "connect", "fireflies", "--credential-fd", "3"],
    ];
    for (const args of cases) {
      const result = await runCli(args, { home, apiUrl: backend.url });
      expect(result.exitCode).toBe(2);
    }
    expect(backend.state.requests).toEqual([]);
  });
});

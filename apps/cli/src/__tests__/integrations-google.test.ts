import { describe, expect, it } from "bun:test";
import { createIntegrationOutput } from "../integrations/safe-output.ts";
import { runGoogleConnect, type GoogleConnectDeps } from "../integrations/providers/google.ts";

const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=s-1&client_id=c";

function output(json: boolean) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, value: createIntegrationOutput({ json, stdout: (v) => stdout.push(v), stderr: (v) => stderr.push(v) }) };
}

function dependencies(polls: Array<Awaited<ReturnType<GoogleConnectDeps["poll"]>>>, overrides: Partial<GoogleConnectDeps> = {}) {
  const launches: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const deps: GoogleConnectDeps = {
    createSession: async () => ({ ok: true, value: { code: "s-1", authUrl } }),
    poll: async () => polls.shift() ?? { ok: true, value: { status: "pending" } },
    launcher: { launchBrowser: async (url) => { launches.push(url); return { opened: true }; } },
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    onSignal: () => {},
    offSignal: () => {},
    ...overrides,
  };
  return { deps, launches, sleeps };
}

describe("Google connect provider", () => {
  it("prints the sign-in link, opens it, polls every 2s and reports connected", async () => {
    const { deps, launches, sleeps } = dependencies([{ ok: true, value: { status: "pending" } }, { ok: true, value: { status: "connected" } }]);
    const out = output(true);
    expect(await runGoogleConnect({ noOpen: false }, out.value, deps)).toBe(0);
    expect(out.stdout.map((line) => JSON.parse(line))).toEqual([
      { schema_version: 1, status: "action_required", provider: "google", url: authUrl },
      { schema_version: 1, status: "connected", provider: "google" },
    ]);
    expect(launches).toEqual([authUrl]);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it("does not open the browser with --no-open", async () => {
    const { deps, launches } = dependencies([{ ok: true, value: { status: "connected" } }]);
    expect(await runGoogleConnect({ noOpen: true }, output(true).value, deps)).toBe(0);
    expect(launches).toEqual([]);
  });

  it("times out after 10 minutes and reports a failed sign-in", async () => {
    const timed = dependencies([]);
    const out = output(true);
    expect(await runGoogleConnect({ noOpen: true }, out.value, timed.deps)).toBe(1);
    expect(JSON.parse(out.stdout.at(-1)!)).toMatchObject({ status: "error", code: "timed_out" });
    expect(timed.sleeps.length).toBe(300);

    const failed = dependencies([{ ok: true, value: { status: "error", errorCode: "access_denied" } }]);
    const failedOut = output(true);
    expect(await runGoogleConnect({ noOpen: true }, failedOut.value, failed.deps)).toBe(1);
    expect(JSON.parse(failedOut.stdout.at(-1)!)).toMatchObject({ code: "poll_failed" });
  });

  it("refuses a sign-in link that is not Google's", async () => {
    const { deps } = dependencies([], { createSession: async () => ({ ok: true, value: { code: "s", authUrl: "https://evil.example/auth" } }) });
    const out = output(true);
    expect(await runGoogleConnect({ noOpen: true }, out.value, deps)).toBe(1);
    expect(JSON.parse(out.stdout[0]!)).toMatchObject({ code: "request_failed" });
  });
});

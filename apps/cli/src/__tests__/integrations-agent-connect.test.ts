import { describe, expect, it } from "bun:test";
import { parseAgentConnectArgs, runAgentConnect, type AgentConnectDeps } from "../integrations/agent.ts";
import type { ToolCallResult } from "../cloud-client.ts";

const EXPIRES_AT = "2026-11-14T12:15:00.000Z";
const LINK = {
  status: "action_required",
  action: "connect_linear",
  provider: "linear",
  url: "https://draft.example/connect/token-1",
  expiresAt: EXPIRES_AT,
  message: "Ask the person to open this link.",
};

function harness(options: {
  connect: ToolCallResult;
  lists?: unknown[];
  startMs?: number;
}) {
  let nowMs = Date.parse("2026-11-14T12:00:00.000Z") + (options.startMs ?? 0);
  const lists = [...(options.lists ?? [])];
  const calls: Array<{ name: string; input: unknown }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: AgentConnectDeps = {
    callTool: async (name, input) => {
      calls.push({ name, input });
      if (name === "connections.connect") return options.connect;
      const next = lists.shift() ?? { integrations: [{ provider: "linear", status: "not_connected" }] };
      return { ok: true, output: next };
    },
    now: () => nowMs,
    sleep: async (ms) => { nowMs += ms; },
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  };
  return { deps, calls, stdout, stderr };
}

const linkResult: ToolCallResult = { ok: true, output: LINK };

describe("parseAgentConnectArgs", () => {
  it("accepts a provider with --json and --wait, each at most once", () => {
    expect(parseAgentConnectArgs(["linear", "--json", "--wait"])).toEqual({ provider: "linear", json: true, wait: true });
    expect(parseAgentConnectArgs(["claude-code"])).toEqual({ provider: "claude-code", json: false, wait: false });
    expect(parseAgentConnectArgs(["granola", "--json"])).toEqual({ provider: "granola", json: true, wait: false });
  });

  it.each([
    [["linear", "--no-open"]],
    [["linear", "--json", "--json"]],
    [["linear", "extra"]],
    [["--json", "linear"]],
    [["unknown"]],
    [[]],
  ])("rejects %j", (args) => {
    expect(parseAgentConnectArgs(args)).toBeNull();
  });
});

describe("runAgentConnect", () => {
  it("prints the link as one JSON line and exits 0 without --wait", async () => {
    const h = harness({ connect: linkResult });
    const code = await runAgentConnect({ provider: "linear", json: true, wait: false }, h.deps);
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ name: "connections.connect", input: { provider: "linear" } }]);
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0]!)).toEqual({ schema_version: 1, ...LINK });
  });

  it("maps claude-code to the claude_session provider", async () => {
    const h = harness({ connect: { ok: true, output: { ...LINK, provider: "claude_session" } } });
    await runAgentConnect({ provider: "claude-code", json: true, wait: false }, h.deps);
    expect(h.calls[0]).toEqual({ name: "connections.connect", input: { provider: "claude_session" } });
  });

  it("prints a human link line without --json", async () => {
    const h = harness({ connect: linkResult });
    await runAgentConnect({ provider: "linear", json: false, wait: false }, h.deps);
    expect(h.stdout.join("")).toBe(`Open this link to connect Linear: ${LINK.url} (expires ${EXPIRES_AT})\n`);
  });

  it("with --wait polls connections.list until the provider is connected", async () => {
    const h = harness({
      connect: linkResult,
      lists: [
        { integrations: [{ provider: "linear", status: "not_connected" }] },
        { integrations: [{ provider: "linear", status: "connected" }] },
      ],
    });
    const code = await runAgentConnect({ provider: "linear", json: true, wait: true }, h.deps);
    expect(code).toBe(0);
    expect(h.calls.map((call) => call.name)).toEqual(["connections.connect", "connections.list", "connections.list"]);
    const lines = h.stdout.map((line) => JSON.parse(line));
    expect(lines.at(-1)).toEqual({ schema_version: 1, status: "connected", provider: "linear" });
  });

  it("with --wait reports expired without polling when the link is already past its expiry", async () => {
    const h = harness({ connect: linkResult, startMs: 15 * 60_000 + 1_000 });
    const code = await runAgentConnect({ provider: "linear", json: true, wait: true }, h.deps);
    expect(code).toBe(1);
    expect(h.calls.some((call) => call.name === "connections.list")).toBe(false);
    expect(JSON.parse(h.stdout.at(-1)!)).toMatchObject({ status: "error", code: "expired" });
  });

  it("with --wait stops polling at expiry and reports expired", async () => {
    const h = harness({ connect: linkResult, lists: [] });
    const code = await runAgentConnect({ provider: "linear", json: true, wait: true }, h.deps);
    expect(code).toBe(1);
    const listCalls = h.calls.filter((call) => call.name === "connections.list").length;
    expect(listCalls).toBeGreaterThan(0);
    expect(JSON.parse(h.stdout.at(-1)!)).toMatchObject({ status: "error", code: "expired" });
  });

  it("reports an already-connected provider without a link or polling", async () => {
    const h = harness({ connect: { ok: true, output: { status: "connected", provider: "linear" } } });
    const code = await runAgentConnect({ provider: "linear", json: true, wait: true }, h.deps);
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(JSON.parse(h.stdout[0]!)).toEqual({ schema_version: 1, status: "connected", provider: "linear" });
  });

  it("surfaces a refusal as a safe error with the refusal code", async () => {
    const h = harness({ connect: { ok: false, code: "request_failed", refusal: "too_many_requests", message: "Too many open connect links." } });
    const code = await runAgentConnect({ provider: "linear", json: true, wait: false }, h.deps);
    expect(code).toBe(1);
    expect(JSON.parse(h.stdout[0]!)).toMatchObject({ status: "error", code: "too_many_requests", message: "Too many open connect links." });
  });

  it("rejects a malformed connect answer", async () => {
    const h = harness({ connect: { ok: true, output: { status: "action_required", url: 12 } } });
    const code = await runAgentConnect({ provider: "linear", json: true, wait: false }, h.deps);
    expect(code).toBe(1);
    expect(JSON.parse(h.stdout[0]!)).toMatchObject({ status: "error", code: "malformed_response" });
  });
});

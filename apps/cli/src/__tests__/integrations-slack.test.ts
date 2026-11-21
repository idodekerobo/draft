import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createIntegrationOutput } from "../integrations/safe-output.ts";
import {
  runSlackConnect,
  type SlackConnectDeps,
} from "../integrations/providers/slack.ts";
import { SlackProviderError } from "draft-core/integrations/slack-hosted";
import {
  CredentialInputError,
  type CredentialReader,
  type CredentialSource,
  type ProviderCredentials,
} from "../integrations/credentials.ts";
import { ChannelSelectionInterruptedError, type ChannelSelector } from "../integrations/channel-select.ts";
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
const stdinSource: CredentialSource = { kind: "stdin" };

function stubReader(
  read: () => Promise<ProviderCredentials["slack"]>,
): CredentialReader {
  return {
    preflightTty: async () => true,
    read: (async () => read()) as CredentialReader["read"],
  };
}

function stubSelector(select: ChannelSelector["select"]): ChannelSelector {
  return { select };
}

function connectDeps(overrides: Partial<SlackConnectDeps> = {}): { deps: SlackConnectDeps; launches: string[]; handlers: Map<string, () => void>; exitCalls: number[] } {
  const launches: string[] = [];
  const handlers = new Map<string, () => void>();
  const exitCalls: number[] = [];
  const deps: SlackConnectDeps = {
    reader: stubReader(async () => ({ bot_token: "xoxb-good", app_token: "xapp-good" })),
    launcher: { launchBrowser: async (url) => { launches.push(url); return { opened: true }; } },
    selector: stubSelector(async () => []),
    fetchChannels: async () => [],
    connect: async () => ({ ok: true, value: { ok: true } }),
    onSignal: (signal, handler) => { handlers.set(signal, handler); },
    offSignal: (signal) => { handlers.delete(signal); },
    exitProcess: (code) => { exitCalls.push(code); },
    ...overrides,
  };
  return { deps, launches, handlers, exitCalls };
}

describe("Slack connect provider", () => {
  it("emits browser_required with the reviewed manifest URL, then connected", async () => {
    const harness = connectDeps();
    const rendered = output(true);
    expect(await runSlackConnect({ noOpen: true, source: ttySource }, rendered.value, harness.deps)).toBe(0);
    const lines = rendered.stdout.map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ status: "browser_required", provider: "slack" });
    expect(lines[0].url).toContain("https://api.slack.com/apps?new_app=1&manifest_json=");
    expect(lines.at(-1)).toEqual({ schema_version: 1, status: "connected", provider: "slack" });
    expect(harness.exitCalls).toEqual([]);
  });

  it("only opens the browser when --no-open is absent", async () => {
    const opened = connectDeps();
    await runSlackConnect({ noOpen: false, source: ttySource }, output(true).value, opened.deps);
    expect(opened.launches.length).toBe(1);

    const notOpened = connectDeps();
    await runSlackConnect({ noOpen: true, source: ttySource }, output(true).value, notOpened.deps);
    expect(notOpened.launches).toEqual([]);
  });

  it("runs the interactive channel selector only for a tty credential source", async () => {
    let fetchCalled = false;
    let selectCalled = false;
    const connectCalls: unknown[] = [];
    const harness = connectDeps({
      fetchChannels: async () => { fetchCalled = true; return [{ id: "C1", name: "general", memberCount: 5, isMember: false }]; },
      selector: stubSelector(async () => { selectCalled = true; return ["C1"]; }),
      connect: async (body) => { connectCalls.push(body); return { ok: true, value: { ok: true } }; },
    });
    expect(await runSlackConnect({ noOpen: true, source: ttySource }, output(true).value, harness.deps)).toBe(0);
    expect(fetchCalled).toBe(true);
    expect(selectCalled).toBe(true);
    expect(connectCalls).toEqual([{ provider: "slack", bot_token: "xoxb-good", app_token: "xapp-good", channel_ids: ["C1"] }]);
  });

  it("defaults channel_ids to [] for automation credential sources, without calling the selector", async () => {
    let fetchCalled = false;
    let selectCalled = false;
    const connectCalls: unknown[] = [];
    const harness = connectDeps({
      fetchChannels: async () => { fetchCalled = true; return []; },
      selector: stubSelector(async () => { selectCalled = true; return []; }),
      connect: async (body) => { connectCalls.push(body); return { ok: true, value: { ok: true } }; },
    });
    expect(await runSlackConnect({ noOpen: true, source: stdinSource }, output(true).value, harness.deps)).toBe(0);
    expect(fetchCalled).toBe(false);
    expect(selectCalled).toBe(false);
    expect(connectCalls).toEqual([{ provider: "slack", bot_token: "xoxb-good", app_token: "xapp-good", channel_ids: [] }]);
  });

  it("rejects malformed token formats before any network call", async () => {
    const harness = connectDeps({
      reader: stubReader(async () => ({ bot_token: "not-a-bot-token", app_token: "xapp-good" })),
    });
    let connectCalled = false;
    harness.deps.connect = async () => { connectCalled = true; return { ok: true, value: { ok: true } }; };
    const rendered = output(true);
    expect(await runSlackConnect({ noOpen: true, source: ttySource }, rendered.value, harness.deps)).toBe(2);
    expect(connectCalled).toBe(false);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "invalid_credential_input" });
  });

  it("prints the interrupted message, then force-exits, when the credential read is abandoned mid-flight", async () => {
    const harness = connectDeps({
      reader: { preflightTty: async () => true, read: async () => { throw new CredentialInputError("interrupted"); } },
    });
    const rendered = output(true);
    expect(await runSlackConnect({ noOpen: true, source: ttySource }, rendered.value, harness.deps)).toBe(130);
    // The message must be visible before the process is force-exited --
    // otherwise Ctrl-C at this prompt looks like nothing happened at all.
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "interrupted" });
    expect(harness.exitCalls).toEqual([130]);
  });

  it("never renders the raw bot/app tokens, even on a canary-secret failure path", async () => {
    const harness = connectDeps({
      reader: stubReader(async () => ({ bot_token: "xoxb-canary-secret", app_token: "xapp-canary-secret" })),
      connect: async () => ({ ok: false, code: "request_failed" }),
    });
    const rendered = output(true);
    expect(await runSlackConnect({ noOpen: true, source: ttySource }, rendered.value, harness.deps)).toBe(1);
    expect(rendered.stdout.join("")).not.toContain("canary-secret");
  });

  it("maps a channel-list failure to slack_channel_list_failed", async () => {
    const harness = connectDeps({
      fetchChannels: async () => { throw new SlackProviderError("slack_channel_list_failed"); },
    });
    const rendered = output(true);
    expect(await runSlackConnect({ noOpen: true, source: ttySource }, rendered.value, harness.deps)).toBe(1);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "slack_channel_list_failed" });
  });

  it("maps an unparseable selector answer to invalid_credential_input", async () => {
    const harness = connectDeps({
      fetchChannels: async () => [{ id: "C1", name: "general", memberCount: 1, isMember: false }],
      selector: stubSelector(async () => null),
    });
    const rendered = output(true);
    expect(await runSlackConnect({ noOpen: true, source: ttySource }, rendered.value, harness.deps)).toBe(2);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "invalid_credential_input" });
  });

  it("aborts on SIGINT before reading credentials", async () => {
    const harness = connectDeps({
      launcher: {
        launchBrowser: (_url) => new Promise(() => undefined),
      },
      reader: {
        preflightTty: async () => true,
        read: (async () => { throw new Error("must-not-be-called"); }) as CredentialReader["read"],
      },
    });
    const rendered = output(true);
    const pending = runSlackConnect({ noOpen: false, source: ttySource }, rendered.value, harness.deps);
    for (let attempt = 0; attempt < 20 && rendered.stdout.length === 0; attempt++) await Bun.sleep(1);
    harness.handlers.get("SIGINT")?.();
    expect(await pending).toBe(130);
    expect(rendered.stdout.map((line) => JSON.parse(line).status)).toEqual(["browser_required", "error"]);
  });

  it("reports interrupted (not a hang) when SIGINT arrives during interactive channel selection, then force-exits", async () => {
    const harness = connectDeps({
      fetchChannels: async () => [{ id: "C1", name: "general", memberCount: 1, isMember: false }],
      selector: stubSelector((_channels, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new ChannelSelectionInterruptedError()), { once: true });
      })),
    });
    const rendered = output(true);
    const pending = runSlackConnect({ noOpen: true, source: ttySource }, rendered.value, harness.deps);
    await Bun.sleep(0);
    harness.handlers.get("SIGINT")?.();
    expect(await pending).toBe(130);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "interrupted" });
    expect(harness.exitCalls).toEqual([130]);
  });
});

describe("draft connections connect slack / channels", () => {
  let backend: ReturnType<typeof createMockBackend>;
  let home: string;

  beforeEach(() => {
    backend = createMockBackend();
    home = makeHome();
    seedCliAuth(home);
  });

  afterEach(() => backend.stop());

  it("connects slack end-to-end through --credential-stdin with default empty channels", async () => {
    const result = await runCli(["connections", "connect", "--provider", "slack", "--credential-stdin", "--json"], {
      home,
      apiUrl: backend.url,
      stdin: JSON.stringify({ bot_token: "xoxb-e2e", app_token: "xapp-e2e" }),
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ status: "browser_required", provider: "slack" });
    expect(lines.at(-1)).toEqual({ schema_version: 1, status: "connected", provider: "slack" });
    const connectRequest = backend.state.requests.find((request) =>
      request.method === "POST" && new URL(request.url).pathname.endsWith("/connections")
    );
    expect(connectRequest && JSON.parse(connectRequest.body)).toEqual({
      provider: "slack",
      bot_token: "xoxb-e2e",
      app_token: "xapp-e2e",
      channel_ids: [],
    });
  });

  const toolRequest = (name: string) => backend.state.requests.find((request) => new URL(request.url).pathname.endsWith(`/tools/${name}`));

  it("sets the bot's channels through connect --channels, and passes the tool's answer on", async () => {
    backend.state.toolOutputs["connections.connect"] = () => ({
      status: "connected",
      provider: "slack",
      message: "Slack is already connected. Channels updated: 1 joined, 0 left.",
      channels: { ids: ["C1"], joined: ["C1"], left: [], failed: [] },
    });
    const result = await runCli(["connections", "connect", "--provider", "slack", "--channels", "C1,#general", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema_version: 1, status: "connected", provider: "slack", channels: { ids: ["C1"] } });
    expect(JSON.parse(toolRequest("connections.connect")!.body)).toEqual({ provider: "slack", channels: ["C1", "#general"] });
    const human = await runCli(["connections", "connect", "--provider", "slack", "--channels", "C1"], { home, apiUrl: backend.url });
    expect(human.stdout).toContain("Slack is already connected. Channels updated: 1 joined, 0 left.");
  });

  it("fails connect --channels when a channel could not be joined", async () => {
    backend.state.toolOutputs["connections.connect"] = () => ({
      status: "connected",
      provider: "slack",
      message: "Slack is already connected. Channels updated: 0 joined, 0 left. 1 could not be joined.",
      channels: { ids: [], joined: [], left: [], failed: [{ channelId: "C2", operation: "join", code: "slack_channel_join_failed" }] },
    });
    const result = await runCli(["connections", "connect", "--provider", "slack", "--channels", "C2"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("could not be joined");
  });

  it("shows the tool's refusal for a channel that matches nothing", async () => {
    backend.state.toolOutputs["connections.connect"] = () => ({ __refusal: { code: "channel_not_found", message: 'No public Slack channel matches "#nope". Public channels include: #general.' } });
    const result = await runCli(["connections", "connect", "--provider", "slack", "--channels", "#nope"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("#general");
  });

  it("lists a provider's connection with the channels the bot has joined", async () => {
    backend.state.toolOutputs["connections.list"] = () => ({
      connections: [{
        provider: "slack", label: "Slack", status: "connected", connectedByYou: true, ingests: "messages", triggers: [], abilities: [],
        connect: { cli: "draft connections connect --provider slack", mcp: "connections.connect" },
        actions: [{ verb: "read" }, { verb: "post" }, { verb: "connect" }],
        channels: [{ id: "C1", name: "general" }],
      }],
    });
    const result = await runCli(["connections", "list", "--provider", "slack"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("channels the bot has joined: #general");
    expect(result.stdout).toContain("draft connections read --provider slack");
    expect(JSON.parse(toolRequest("connections.list")!.body)).toEqual({ provider: "slack" });
  });

  it("rejects invalid grammar before any request", async () => {
    const cases = [
      ["connections", "connect", "--provider", "slack", "extra"],
      ["connections", "connect", "--provider", "slack", "--json", "--json"],
      ["connections", "connect", "--provider", "slack", "--credential-stdin", "--credential-fd", "3"],
      ["connections", "connect", "--provider", "slack", "--channels"],
      ["connections", "connect", "--provider", "slack", "--channels", "C1", "--wait"],
      ["connections", "connect", "--provider", "linear", "--channels", "C1"],
      ["connections", "connect", "slack"],
      ["connections", "slack", "channels", "list"],
    ];
    for (const args of cases) {
      const result = await runCli(args, { home, apiUrl: backend.url });
      expect(result.exitCode).toBe(2);
    }
    expect(backend.state.requests).toEqual([]);
  });
});


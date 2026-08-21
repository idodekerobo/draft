import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createIntegrationOutput } from "../integrations/safe-output.ts";
import {
  runSlackConnect,
  runSlackChannelsList,
  runSlackChannelsSet,
  type SlackConnectDeps,
  type SlackChannelsListDeps,
  type SlackChannelsSetDeps,
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

const noopSignals = {
  onSignal: () => {},
  offSignal: () => {},
};

function connectDeps(overrides: Partial<SlackConnectDeps> = {}): { deps: SlackConnectDeps; launches: string[]; handlers: Map<string, () => void> } {
  const launches: string[] = [];
  const handlers = new Map<string, () => void>();
  const deps: SlackConnectDeps = {
    reader: stubReader(async () => ({ bot_token: "xoxb-good", app_token: "xapp-good" })),
    launcher: { launchBrowser: async (url) => { launches.push(url); return { opened: true }; } },
    selector: stubSelector(async () => []),
    fetchChannels: async () => [],
    connect: async () => ({ ok: true, value: { ok: true } }),
    onSignal: (signal, handler) => { handlers.set(signal, handler); },
    offSignal: (signal) => { handlers.delete(signal); },
    ...overrides,
  };
  return { deps, launches, handlers };
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

  it("reports interrupted (not a hang) when SIGINT arrives during interactive channel selection", async () => {
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
  });
});

describe("Slack channels list", () => {
  it("renders the connection's channels", async () => {
    const channels = [{ id: "C1", name: "general", memberCount: 10, isMember: true }];
    const deps: SlackChannelsListDeps = { list: async () => ({ ok: true, value: { ok: true, channels } }) };
    const rendered = output(true);
    expect(await runSlackChannelsList(rendered.value, deps)).toBe(0);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toEqual({ schema_version: 1, status: "channels", provider: "slack", channels });
  });

  it("maps a list failure to its safe error code", async () => {
    const deps: SlackChannelsListDeps = { list: async () => ({ ok: false, code: "slack_channel_list_failed" }) };
    const rendered = output(true);
    expect(await runSlackChannelsList(rendered.value, deps)).toBe(1);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "slack_channel_list_failed" });
  });
});

describe("Slack channels set", () => {
  it("uses explicit channel ids directly without listing or prompting", async () => {
    let listCalled = false;
    let selectCalled = false;
    const setCalls: string[][] = [];
    const deps: SlackChannelsSetDeps = {
      list: async () => { listCalled = true; return { ok: true, value: { ok: true, channels: [] } }; },
      set: async (ids) => { setCalls.push(ids); return { ok: true, value: { ok: true, channel_ids: ids, joined: ids, left: [], failed: [] } }; },
      selector: stubSelector(async () => { selectCalled = true; return []; }),
      preflightTty: async () => true,
      ...noopSignals,
    };
    const rendered = output(true);
    expect(await runSlackChannelsSet(["C1", "C2"], rendered.value, deps)).toBe(0);
    expect(listCalled).toBe(false);
    expect(selectCalled).toBe(false);
    expect(setCalls).toEqual([["C1", "C2"]]);
  });

  it("prompts interactively when ids are omitted and a tty is present", async () => {
    const channels = [{ id: "C1", name: "general", memberCount: 3, isMember: true }];
    let selectArg: unknown;
    const deps: SlackChannelsSetDeps = {
      list: async () => ({ ok: true, value: { ok: true, channels } }),
      set: async (ids) => ({ ok: true, value: { ok: true, channel_ids: ids, joined: [], left: [], failed: [] } }),
      selector: stubSelector(async (chans) => { selectArg = chans; return ["C1"]; }),
      preflightTty: async () => true,
      ...noopSignals,
    };
    const rendered = output(true);
    expect(await runSlackChannelsSet(null, rendered.value, deps)).toBe(0);
    expect(selectArg).toEqual(channels);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "channels_set", channel_ids: ["C1"] });
  });

  it("defaults omitted ids to [] when no tty is present (automation)", async () => {
    let listCalled = false;
    const setCalls: string[][] = [];
    const deps: SlackChannelsSetDeps = {
      list: async () => { listCalled = true; return { ok: true, value: { ok: true, channels: [] } }; },
      set: async (ids) => { setCalls.push(ids); return { ok: true, value: { ok: true, channel_ids: ids, joined: [], left: ids, failed: [] } }; },
      selector: stubSelector(async () => []),
      preflightTty: async () => false,
      ...noopSignals,
    };
    const rendered = output(true);
    expect(await runSlackChannelsSet(null, rendered.value, deps)).toBe(0);
    expect(listCalled).toBe(false);
    expect(setCalls).toEqual([[]]);
  });

  it("renders partial-failure warnings without failing the command", async () => {
    const deps: SlackChannelsSetDeps = {
      list: async () => ({ ok: true, value: { ok: true, channels: [] } }),
      set: async (ids) => ({
        ok: true,
        value: {
          ok: false,
          channel_ids: ["C1"],
          joined: ["C1"],
          left: [],
          failed: [{ channel_id: "C2", operation: "join", code: "slack_channel_join_failed" }],
        },
      }),
      selector: stubSelector(async () => []),
      preflightTty: async () => true,
      ...noopSignals,
    };
    const rendered = output(true);
    expect(await runSlackChannelsSet(["C1", "C2"], rendered.value, deps)).toBe(0);
    expect(rendered.stderr).toEqual(["Warning: could not join channel C2.\n"]);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({
      status: "channels_set",
      ok: false,
      failed: [{ channel_id: "C2", operation: "join", code: "slack_channel_join_failed" }],
    });
  });

  it("renders empty-selection convergence (leaving all channels) cleanly", async () => {
    const deps: SlackChannelsSetDeps = {
      list: async () => ({ ok: true, value: { ok: true, channels: [] } }),
      set: async (ids) => ({ ok: true, value: { ok: true, channel_ids: [], joined: [], left: ["C1", "C2"], failed: [] } }),
      selector: stubSelector(async () => []),
      preflightTty: async () => true,
      ...noopSignals,
    };
    const rendered = output(false);
    expect(await runSlackChannelsSet([], rendered.value, deps)).toBe(0);
    expect(rendered.stdout.join("")).toBe("Slack channels: 0 selected (0 joined, 2 left)\n");
    expect(rendered.stderr).toEqual([]);
  });

  it("retries to convergence: a second set() call with the same ids succeeds cleanly", async () => {
    let attempt = 0;
    const deps: SlackChannelsSetDeps = {
      list: async () => ({ ok: true, value: { ok: true, channels: [] } }),
      set: async (ids) => {
        attempt++;
        if (attempt === 1) {
          return { ok: true, value: { ok: false, channel_ids: [], joined: [], left: [], failed: [{ channel_id: "C1", operation: "join", code: "slack_channel_join_failed" }] } };
        }
        return { ok: true, value: { ok: true, channel_ids: ids, joined: ids, left: [], failed: [] } };
      },
      selector: stubSelector(async () => []),
      preflightTty: async () => true,
      ...noopSignals,
    };
    const rendered1 = output(true);
    expect(await runSlackChannelsSet(["C1"], rendered1.value, deps)).toBe(0);
    expect(JSON.parse(rendered1.stdout.at(-1)!)).toMatchObject({ ok: false });

    const rendered2 = output(true);
    expect(await runSlackChannelsSet(["C1"], rendered2.value, deps)).toBe(0);
    expect(JSON.parse(rendered2.stdout.at(-1)!)).toMatchObject({ ok: true, channel_ids: ["C1"] });
  });

  it("reports interrupted (not a hang) when SIGINT arrives during interactive channel selection", async () => {
    const handlers = new Map<string, () => void>();
    const deps: SlackChannelsSetDeps = {
      list: async () => ({ ok: true, value: { ok: true, channels: [{ id: "C1", name: "general", memberCount: 1, isMember: false }] } }),
      set: async () => ({ ok: true, value: { ok: true, channel_ids: [], joined: [], left: [], failed: [] } }),
      selector: stubSelector((_channels, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new ChannelSelectionInterruptedError()), { once: true });
      })),
      preflightTty: async () => true,
      onSignal: (signal, handler) => { handlers.set(signal, handler); },
      offSignal: (signal) => { handlers.delete(signal); },
    };
    const rendered = output(true);
    const pending = runSlackChannelsSet(null, rendered.value, deps);
    await Bun.sleep(0);
    handlers.get("SIGINT")?.();
    expect(await pending).toBe(130);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "interrupted" });
  });
});

describe("draft integrations connect slack / channels", () => {
  let backend: ReturnType<typeof createMockBackend>;
  let home: string;

  beforeEach(() => {
    backend = createMockBackend();
    home = makeHome();
    seedCliAuth(home);
  });

  afterEach(() => backend.stop());

  it("connects slack end-to-end through --credential-stdin with default empty channels", async () => {
    const result = await runCli(["integrations", "connect", "slack", "--credential-stdin", "--json"], {
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

  it("lists and sets slack channels end-to-end", async () => {
    backend.state.slackChannelsResponse = () => Response.json({
      ok: true,
      channels: [{ id: "C1", name: "general", memberCount: 4, isMember: false }],
    });
    const listResult = await runCli(["integrations", "slack", "channels", "list", "--json"], { home, apiUrl: backend.url });
    expect(listResult.exitCode).toBe(0);
    expect(JSON.parse(listResult.stdout)).toEqual({
      schema_version: 1,
      status: "channels",
      provider: "slack",
      channels: [{ id: "C1", name: "general", memberCount: 4, isMember: false }],
    });

    backend.state.slackMembershipResponse = () => Response.json({
      ok: true,
      channel_ids: ["C1"],
      joined: ["C1"],
      left: [],
      failed: [],
    });
    const setResult = await runCli(["integrations", "slack", "channels", "set", "C1", "--json"], { home, apiUrl: backend.url });
    expect(setResult.exitCode).toBe(0);
    expect(JSON.parse(setResult.stdout)).toEqual({
      schema_version: 1,
      status: "channels_set",
      provider: "slack",
      ok: true,
      channel_ids: ["C1"],
      joined: ["C1"],
      left: [],
      failed: [],
    });
    const patchRequest = backend.state.requests.find((request) => request.method === "PATCH");
    expect(patchRequest && JSON.parse(patchRequest.body)).toEqual({ channel_ids: ["C1"] });
  });

  it("defaults to an empty channel set when ids are omitted non-interactively", async () => {
    backend.state.slackMembershipResponse = () => Response.json({
      ok: true,
      channel_ids: [],
      joined: [],
      left: ["C1"],
      failed: [],
    });
    const result = await runCli(["integrations", "slack", "channels", "set", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    const patchRequest = backend.state.requests.find((request) => request.method === "PATCH");
    expect(patchRequest && JSON.parse(patchRequest.body)).toEqual({ channel_ids: [] });
    expect(backend.state.requests.some((request) => request.method === "GET" && new URL(request.url).pathname.endsWith("/channels"))).toBe(false);
  });

  it("rejects invalid grammar before any request", async () => {
    const cases = [
      ["integrations", "connect", "slack", "extra"],
      ["integrations", "connect", "slack", "--json", "--json"],
      ["integrations", "connect", "slack", "--credential-stdin", "--credential-fd", "3"],
      ["integrations", "slack"],
      ["integrations", "slack", "channels"],
      ["integrations", "slack", "channels", "list", "extra"],
      ["integrations", "slack", "channels", "set", "--unknown"],
      ["integrations", "slack", "unknown"],
    ];
    for (const args of cases) {
      const result = await runCli(args, { home, apiUrl: backend.url });
      expect(result.exitCode).toBe(2);
    }
    expect(backend.state.requests).toEqual([]);
  });
});

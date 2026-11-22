import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "fs";
import { createMockBackend } from "./helpers/mock-backend.ts";
import { makeHome, runCli, seedCliAuth } from "./helpers/cli-runner.ts";
import { runConnectionsJoin, runConnectionsLeave, type ChannelChangeDeps } from "../integrations/tool-commands.ts";

let backend: ReturnType<typeof createMockBackend>;
let home: string;

beforeEach(() => {
  backend = createMockBackend();
  home = makeHome();
  seedCliAuth(home);
});
afterEach(() => {
  backend.stop();
  rmSync(home, { recursive: true, force: true });
});

const toolBodies = (name: string) => backend.state.requests
  .filter((request) => new URL(request.url).pathname.endsWith(`/tools/${name}`))
  .map((request) => JSON.parse(request.body));

const run = (args: string[], stdin?: string) => runCli(["connections", ...args], { home, apiUrl: backend.url, stdin });

describe("draft connections read", () => {
  const messages = {
    provider: "slack",
    channel: { id: "C1", name: "general" },
    messages: [{ ts: "1700000000.000100", user: "U1", text: "Deploy at 10" }, { ts: "1700000060.000200", username: "ci", text: "Build passed" }],
    has_more: true,
  };

  it("reads a channel through connections.read and prints one line per message", async () => {
    backend.state.toolOutputs["connections.read"] = () => messages;
    const result = await run(["read", "--provider", "slack", "--channel", "#general", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("#general");
    expect(result.stdout).toContain("2023-11-14 22:13  U1: Deploy at 10");
    expect(result.stdout).toContain("ci: Build passed");
    expect(result.stdout).toContain("More messages exist");
    expect(toolBodies("connections.read")).toEqual([{ provider: "slack", channel: "#general", limit: 5 }]);
  });

  it("prints the tool's output as JSON", async () => {
    backend.state.toolOutputs["connections.read"] = () => messages;
    const result = await run(["read", "--provider=slack", "--channel=C1", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, ...messages });
    expect(toolBodies("connections.read")).toEqual([{ provider: "slack", channel: "C1" }]);
  });

  it("shows the tool's refusal, including what would have worked", async () => {
    backend.state.toolOutputs["connections.read"] = () => ({ __refusal: { code: "channel_not_allowed", message: "The bot is not a member of that Slack channel. Channels it has joined: #general." } });
    const result = await run(["read", "--provider", "slack", "--channel", "#nope"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Channels it has joined: #general.");
    const json = await run(["read", "--provider", "slack", "--channel", "#nope", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ status: "error", code: "channel_not_allowed" });
  });

  it("says to sign in when nobody is", async () => {
    const bareHome = makeHome();
    try {
      const result = await runCli(["connections", "read", "--provider", "slack", "--channel", "C1"], { home: bareHome, apiUrl: backend.url });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Not signed in.");
      expect(result.stderr).toContain("draft auth login");
    } finally {
      rmSync(bareHome, { recursive: true, force: true });
    }
  });
});

describe("draft connections post", () => {
  const posted = { provider: "slack", channel: { id: "C1", name: "standup" } };

  it("posts the text through connections.post", async () => {
    backend.state.toolOutputs["connections.post"] = () => posted;
    const result = await run(["post", "--provider", "slack", "--channel", "#standup", "--text", "Deploy is done."]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Posted in #standup.");
    expect(toolBodies("connections.post")).toEqual([{ provider: "slack", channel: "#standup", text: "Deploy is done." }]);
  });

  it("reads the message from stdin with --text -", async () => {
    backend.state.toolOutputs["connections.post"] = () => posted;
    const result = await run(["post", "--provider", "slack", "--channel", "C1", "--text", "-", "--json"], "Line one\nLine two\n");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, ...posted });
    expect(toolBodies("connections.post")).toEqual([{ provider: "slack", channel: "C1", text: "Line one\nLine two" }]);
  });

  it("shows a refusal such as a limit reached", async () => {
    backend.state.toolOutputs["connections.post"] = () => ({ __refusal: { code: "limit_reached", message: "This run has posted 10 Slack messages, its limit." } });
    const result = await run(["post", "--provider", "slack", "--channel", "C1", "--text", "hi"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("its limit");
  });

  it("passes on an invalid-input answer from the tool", async () => {
    backend.state.toolOutputs["connections.post"] = () => ({ __invalid: ["text: Too big"] });
    const result = await run(["post", "--provider", "slack", "--channel", "C1", "--text", "hi"]);
    expect(result.exitCode).toBe(1);
  });
});

describe("draft connections connect, already connected", () => {
  it("prints the message and no link when the provider is already connected", async () => {
    backend.state.toolOutputs["connections.connect"] = () => ({ status: "connected", provider: "linear", message: "Linear is already connected. No link is needed." });
    const human = await run(["connect", "--provider", "linear", "--json"]);
    expect(human.exitCode).toBe(0);
    expect(JSON.parse(human.stdout)).toEqual({ schema_version: 1, status: "connected", provider: "linear", message: "Linear is already connected. No link is needed." });
    const text = await runCli(["connections", "connect", "--provider", "linear", "--credential-stdin"], { home, apiUrl: backend.url, stdin: "{}" });
    expect(text.stdout).not.toContain("Open this link");
  });

  it("says a saved connection is waiting for its first event", async () => {
    backend.state.toolOutputs["connections.connect"] = () => ({ status: "pending", provider: "fireflies", message: "Fireflies is saved and waiting for its first event from the provider. No link is needed." });
    const result = await run(["connect", "--provider", "fireflies", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "pending", provider: "fireflies" });
  });
});

describe("draft connections list --available", () => {
  const slackItem = (extra: Record<string, unknown> = {}) => ({
    provider: "slack", label: "Slack", status: "connected", connectedByYou: true, ingests: "messages", triggers: [], abilities: [],
    connect: { cli: "draft connections connect --provider slack", mcp: "connections.connect" },
    actions: [{ verb: "read" }, { verb: "post" }, { verb: "join" }, { verb: "leave" }],
    channels: [{ id: "C-general", name: "general" }],
    ...extra,
  });
  const page = {
    channels: [
      { id: "C-general", name: "general", memberCount: 100, joined: true },
      { id: "C-random", name: "random", memberCount: 80, joined: false },
    ],
    nextCursor: "abc",
  };

  it("lists every public channel with ids, sizes and whether the bot is in it, and says how to get the next page", async () => {
    backend.state.toolOutputs["connections.list"] = () => ({ connections: [slackItem({ available: page })] });
    const result = await run(["list", "--provider", "slack", "--available", "--query", "e", "--limit", "2"]);
    expect(result.exitCode).toBe(0);
    expect(toolBodies("connections.list")).toEqual([{ provider: "slack", available: true, query: "e", limit: 2 }]);
    expect(result.stdout).toContain("channels the bot has joined: #general");
    expect(result.stdout).toContain('every public channel, biggest first (matching "e")');
    expect(result.stdout).toMatch(/#general\s+C-general\s+100 members\s+in\b/);
    expect(result.stdout).toMatch(/#random\s+C-random\s+80 members\s+not in\b/);
    expect(result.stdout).toContain("More: draft connections list --provider slack --available --query 'e' --limit 2 --cursor 'abc'");
    expect(result.stdout).toContain("Join one: draft connections join --provider slack --channel '#name'");
  });

  it("has no More line on the last page, and passes the cursor along", async () => {
    backend.state.toolOutputs["connections.list"] = () => ({ connections: [slackItem({ available: { ...page, nextCursor: null } })] });
    const result = await run(["list", "--provider", "slack", "--available", "--cursor", "abc"]);
    expect(result.exitCode).toBe(0);
    expect(toolBodies("connections.list")).toEqual([{ provider: "slack", available: true, cursor: "abc" }]);
    expect(result.stdout).not.toContain("More:");
  });

  it("prints the tool's output as JSON, with the joined channels and the page", async () => {
    const output = { connections: [slackItem({ available: page })] };
    backend.state.toolOutputs["connections.list"] = () => output;
    const result = await run(["list", "--provider", "slack", "--available", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual(output);
  });

  it("says why when the channels could not be listed", async () => {
    backend.state.toolOutputs["connections.list"] = () => ({ connections: [slackItem({ channels: undefined, available: undefined, availableError: "Slack is not connected for this workspace." })] });
    const result = await run(["list", "--provider", "slack", "--available"]);
    expect(result.stdout).toContain("every public channel: Slack is not connected for this workspace.");
  });

  it("rejects --available without a provider, the paging flags without --available, and a bad limit, before any request", async () => {
    const cases = [
      ["list", "--available"],
      ["list", "--provider", "slack", "--query", "eng"],
      ["list", "--provider", "slack", "--limit", "5"],
      ["list", "--provider", "slack", "--cursor", "abc"],
      ["list", "--provider", "slack", "--available", "--limit", "0"],
      ["list", "--provider", "slack", "--available", "--limit", "101"],
      ["list", "--provider", "slack", "--available", "--limit", "many"],
      ["list", "--provider", "slack", "--available", "--available"],
      ["list", "--provider", "slack", "--available", "--query"],
    ];
    for (const args of cases) expect((await run(args)).exitCode).toBe(2);
    expect(backend.state.requests).toEqual([]);
  });
});

describe("draft connections join without --channel, in a terminal", () => {
  const listOutput = (channels: Array<Record<string, unknown>>, nextCursor: string | null = null) => ({
    connections: [{ provider: "slack", status: "connected", available: { channels, nextCursor } }],
  });
  const general = { id: "C-general", name: "general", memberCount: 100, joined: true };
  const random = { id: "C-random", name: "random", memberCount: 80, joined: false };
  const eng = { id: "C-eng", name: "eng", memberCount: 60, joined: false };

  function setup(options: { interactive?: boolean; picked?: string[] | null; channels?: Array<Record<string, unknown>>; nextCursor?: string | null }) {
    const calls: Array<{ tool: string; input: unknown }> = [];
    const shown: Array<Array<{ id: string; name: string; isMember: boolean }>> = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const log = spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    const error = spyOn(console, "error").mockImplementation((...args) => { errors.push(args.join(" ")); });
    const deps: ChannelChangeDeps = {
      callTool: (async (tool: string, input: unknown) => {
        calls.push({ tool, input });
        if (tool === "connections.list") return { ok: true, output: listOutput(options.channels ?? [general, random, eng], options.nextCursor ?? null) };
        return { ok: true, output: { status: "joined", provider: "slack", changed: [{ id: "C-random", name: "random" }], unchanged: [], failed: [], message: "Joined #random." } };
      }) as ChannelChangeDeps["callTool"],
      interactive: () => options.interactive ?? true,
      selector: { select: async (channels) => { shown.push(channels.map(({ id, name, isMember }) => ({ id, name, isMember }))); return options.picked === undefined ? ["C-random"] : options.picked; } },
    };
    return { deps, calls, shown, logs, errors, restore: () => { log.mockRestore(); error.mockRestore(); } };
  }

  it("shows only the channels the bot is not in, then joins the ones picked", async () => {
    const t = setup({ picked: ["C-random", "C-eng"] });
    try {
      const code = await runConnectionsJoin(["--provider", "slack"], t.deps);
      expect(code).toBe(0);
      expect(t.calls[0]).toEqual({ tool: "connections.list", input: { provider: "slack", available: true, limit: 100 } });
      expect(t.shown).toEqual([[{ id: "C-random", name: "random", isMember: false }, { id: "C-eng", name: "eng", isMember: false }]]);
      expect(t.calls[1]).toEqual({ tool: "connections.join", input: { provider: "slack", channels: ["C-random", "C-eng"] } });
      expect(t.logs).toContain("Joined #random.");
    } finally { t.restore(); }
  });

  it("joins nothing when nothing is picked", async () => {
    const t = setup({ picked: [] });
    try {
      expect(await runConnectionsJoin(["--provider", "slack"], t.deps)).toBe(0);
      expect(t.calls.map((call) => call.tool)).toEqual(["connections.list"]);
      expect(t.logs).toContain("No channels chosen.");
    } finally { t.restore(); }
  });

  it("says so, and asks nothing, when the bot is in every channel listed", async () => {
    const t = setup({ channels: [general] });
    try {
      expect(await runConnectionsJoin(["--provider", "slack"], t.deps)).toBe(0);
      expect(t.shown).toEqual([]);
      expect(t.logs.join("\n")).toContain("already in every channel listed");
    } finally { t.restore(); }
  });

  it("tells the person to name a channel when more than one page exists", async () => {
    const t = setup({ nextCursor: "more" });
    try {
      await runConnectionsJoin(["--provider", "slack"], t.deps);
      expect(t.errors.join("\n")).toContain("Showing the 100 biggest channels");
      expect(t.errors.join("\n")).toContain("--channel '#name'");
    } finally { t.restore(); }
  });

  it("never opens the picker for --json or without a terminal", async () => {
    const t = setup({ interactive: true });
    const headless = setup({ interactive: false });
    try {
      expect(await runConnectionsJoin(["--provider", "slack", "--json"], t.deps)).toBe(2);
      expect(await runConnectionsJoin(["--provider", "slack"], headless.deps)).toBe(2);
      expect(t.calls).toEqual([]);
      expect(headless.calls).toEqual([]);
      expect(t.shown).toEqual([]);
    } finally { t.restore(); headless.restore(); }
  });

  it("never opens a picker to leave", async () => {
    const t = setup({ interactive: true });
    try {
      expect(await runConnectionsLeave(["--provider", "slack"], t.deps)).toBe(2);
      expect(t.calls).toEqual([]);
    } finally { t.restore(); }
  });
});

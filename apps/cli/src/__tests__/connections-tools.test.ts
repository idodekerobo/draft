import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "fs";
import { createMockBackend } from "./helpers/mock-backend.ts";
import { makeHome, runCli, seedCliAuth } from "./helpers/cli-runner.ts";

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

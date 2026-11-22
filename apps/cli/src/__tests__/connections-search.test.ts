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

const run = (args: string[]) => runCli(["connections", ...args], { home, apiUrl: backend.url });

describe("draft connections search", () => {
  const page = { provider: "gmail", results: [{ id: "m1", title: "Cal meeting", snippet: "Moved to 10", date: "2026-11-10" }, { id: "m2", title: "Re: cal", snippet: "Works", date: "2026-11-09" }], nextCursor: "abc def" };

  it("sends the flags as tool fields and prints one line per result with the next command", async () => {
    backend.state.toolOutputs["connections.search"] = () => page;
    const result = await run(["search", "--provider", "gmail", "--query", "cal meeting", "--since", "2026-11-01", "--limit", "5"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cal meeting");
    expect(result.stdout).toContain("(m1)");
    expect(result.stdout).toContain("More: draft connections search --provider gmail --query 'cal meeting' --since 2026-11-01 --limit 5 --cursor 'abc def'");
    expect(toolBodies("connections.search")).toEqual([{ provider: "gmail", query: "cal meeting", since: "2026-11-01", limit: 5 }]);
  });

  it("names Google Drive with an underscore for the backend, and passes its flags", async () => {
    backend.state.toolOutputs["connections.search"] = () => ({ provider: "google_drive", results: [], nextCursor: null });
    const result = await run(["search", "--provider", "google-drive", "--query", "plan", "--file-id", "F1", "--include-history"]);
    expect(result.stdout).toContain("No results.");
    expect(toolBodies("connections.search")).toEqual([{ provider: "google_drive", query: "plan", fileId: "F1", includeHistory: true }]);
  });

  it("prints the tool's output as JSON", async () => {
    backend.state.toolOutputs["connections.search"] = () => page;
    const result = await run(["search", "--provider", "gmail", "--query", "x", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, ...page });
  });

  it("needs a query, a known provider and a sensible limit", async () => {
    expect((await run(["search", "--provider", "gmail"])).exitCode).toBe(2);
    const unknown = await run(["search", "--provider", "drive", "--query", "x"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("google-drive");
    expect((await run(["search", "--provider", "gmail", "--query", "x", "--limit", "51"])).exitCode).toBe(2);
    expect(toolBodies("connections.search")).toEqual([]);
  });

  it("shows the tool's refusal", async () => {
    backend.state.toolOutputs["connections.search"] = () => ({ __refusal: { code: "unsupported_action", message: "slack does not support search." } });
    const result = await run(["search", "--provider", "slack", "--query", "x"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("slack does not support search.");
  });
});

describe("draft connections read and join for providers beyond Slack", () => {
  it("reads a Gmail message with its own flags and no channel", async () => {
    backend.state.toolOutputs["connections.read"] = () => ({ provider: "gmail", id: "m1" });
    const result = await run(["read", "--provider", "gmail", "--message-id", "m1", "--max-bytes", "500"]);
    expect(result.exitCode).toBe(0);
    expect(toolBodies("connections.read")).toEqual([{ provider: "gmail", messageId: "m1", maxBytes: 500 }]);
  });

  it("sends --include versions as a list, and rejects other values and a Slack read without a channel", async () => {
    backend.state.toolOutputs["connections.read"] = () => ({ provider: "google_drive" });
    await run(["read", "--provider", "google-drive", "--file-id", "F1", "--include", "versions"]);
    expect(toolBodies("connections.read")).toEqual([{ provider: "google_drive", fileId: "F1", include: ["versions"] }]);
    expect((await run(["read", "--provider", "google-drive", "--file-id", "F1", "--include", "everything"])).exitCode).toBe(2);
    expect((await run(["read", "--provider", "slack"])).exitCode).toBe(2);
  });

  it("joins folders for Google Drive, and refuses folders together with channels", async () => {
    backend.state.toolOutputs["connections.join"] = () => ({ status: "joined", provider: "google_drive", message: "Syncing 2 folders." });
    const result = await run(["join", "--provider", "google-drive", "--folder", "F1, F2"]);
    expect(result.stdout).toContain("Syncing 2 folders.");
    expect(toolBodies("connections.join")).toEqual([{ provider: "google_drive", folders: ["F1", "F2"] }]);
    expect((await run(["join", "--provider", "slack", "--folder", "F1", "--channel", "#a"])).exitCode).toBe(2);
  });

  it("points Gmail and Google Drive to google when connecting", async () => {
    const result = await run(["connect", "--provider", "gmail"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--provider google");
  });
});

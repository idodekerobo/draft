import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { createMockBackend, refusal } from "./helpers/mock-backend.ts";
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

const ID = "11111111-1111-4111-8111-111111111111";
const uzo = { id: ID, displayName: "Uzo", status: "active", isUser: true, reachable: { slack: true } };
const cory = { id: "22222222-2222-4222-8222-222222222222", displayName: "Cory Banks", status: "pending", isUser: false, reachable: { slack: false } };

const run = (args: string[]) => runCli(["people", ...args], { home, apiUrl: backend.url });

describe("draft people find", () => {
  test("sends the filters and prints each person with their status", async () => {
    let seen: Record<string, unknown> = {};
    backend.state.toolOutputs["people.find"] = (input) => { seen = input; return { people: [uzo] }; };
    const result = await run(["find", "uzo", "--email", "uzo@example.com"]);
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ name: "uzo", email: "uzo@example.com" });
    expect(result.stdout).toContain("Uzo");
    expect(result.stdout).toContain("has an account");
    expect(result.stdout).toContain("Slack");
  });

  test("--me asks for the caller's own person", async () => {
    let seen: Record<string, unknown> = {};
    backend.state.toolOutputs["people.find"] = (input) => { seen = input; return { people: [uzo] }; };
    await run(["find", "--me"]);
    expect(seen).toEqual({ me: true });
  });

  test("--json prints { people } with schema_version", async () => {
    backend.state.toolOutputs["people.find"] = () => ({ people: [uzo] });
    const result = await run(["find", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, people: [uzo] });
  });

  test("says when nobody matches", async () => {
    backend.state.toolOutputs["people.find"] = () => ({ people: [] });
    expect((await run(["find", "nobody"])).stdout).toBe("No people found.");
  });

  test("an unknown flag is invalid usage, exit 2", async () => {
    expect((await run(["find", "--wat"])).exitCode).toBe(2);
  });
});

describe("draft people pending", () => {
  test("asks for pending people only", async () => {
    let seen: Record<string, unknown> = {};
    backend.state.toolOutputs["people.find"] = (input) => { seen = input; return { people: [cory] }; };
    const result = await run(["pending"]);
    expect(seen).toEqual({ status: "pending" });
    expect(result.stdout).toContain("Cory Banks");
    expect(result.stdout).toContain("pending");
  });

  test("says when nobody waits", async () => {
    backend.state.toolOutputs["people.find"] = () => ({ people: [] });
    expect((await run(["pending"])).stdout).toBe("Nobody is waiting for approval.");
  });
});

describe("draft people create", () => {
  test("sends the name, identities and a default quote, and says the person waits for an admin", async () => {
    let seen: Record<string, unknown> = {};
    backend.state.toolOutputs["people.create"] = (input) => { seen = input; return { created: true, person: cory }; };
    const result = await run(["create", "Cory Banks", "--email", "cory@acme.com", "--slack", "U7"]);
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({
      displayName: "Cory Banks",
      evidence: { quote: "Added from the Draft CLI" },
      identities: [{ provider: "email", externalId: "cory@acme.com" }, { provider: "slack", externalId: "U7" }],
    });
    expect(result.stdout).toContain("wait for an admin");
  });

  test("passes --quote and --force", async () => {
    let seen: Record<string, unknown> = {};
    backend.state.toolOutputs["people.create"] = (input) => { seen = input; return { created: true, person: { ...cory, status: "active" } }; };
    await run(["create", "Sam", "--quote", "joined the standup", "--force"]);
    expect(seen).toMatchObject({ evidence: { quote: "joined the standup" }, force: true });
  });

  test("explains candidates and rejections instead of failing", async () => {
    backend.state.toolOutputs["people.create"] = () => ({ created: false, candidates: [uzo] });
    expect((await run(["create", "Uz"])).stdout).toContain("similar name");
    backend.state.toolOutputs["people.create"] = () => ({ created: false, rejected: true });
    expect((await run(["create", "Cory"])).stdout).toContain("rejected before");
  });

  test("needs a name", async () => {
    expect((await run(["create"])).exitCode).toBe(2);
  });
});

describe("draft people approve and reject", () => {
  test("approves by id without looking anyone up", async () => {
    let seen: Record<string, unknown> = {};
    backend.state.toolOutputs["people.approve"] = (input) => { seen = input; return { person: { ...cory, status: "active" } }; };
    const result = await run(["approve", cory.id]);
    expect(seen).toEqual({ personId: cory.id });
    expect(result.stdout).toBe("Approved Cory Banks.");
  });

  test("finds a pending person by name, then approves them", async () => {
    backend.state.toolOutputs["people.find"] = () => ({ people: [cory] });
    backend.state.toolOutputs["people.approve"] = () => ({ person: { ...cory, status: "active" } });
    expect((await run(["approve", "cory"])).stdout).toBe("Approved Cory Banks.");
  });

  test("asks for an id when a name matches more than one pending person", async () => {
    backend.state.toolOutputs["people.find"] = () => ({ people: [cory, { ...cory, id: "33333333-3333-4333-8333-333333333333" }] });
    const result = await run(["approve", "cory"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("More than one pending person");
  });

  test("sends a rejection reason", async () => {
    let seen: Record<string, unknown> = {};
    backend.state.toolOutputs["people.reject"] = (input) => { seen = input; return { person: { ...cory, status: "rejected" } }; };
    const result = await run(["reject", cory.id, "--reason", "a client"]);
    expect(seen).toEqual({ personId: cory.id, reason: "a client" });
    expect(result.stdout).toBe("Rejected Cory Banks.");
  });

  test("shows the tool's own refusal, such as not_admin, and exits 1", async () => {
    backend.state.toolOutputs["people.approve"] = () => refusal("not_admin", "Only an admin can approve or reject people.");
    const result = await run(["approve", cory.id]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Only an admin can approve or reject people.");
  });

  test("--json prints the refusal as an error payload", async () => {
    backend.state.toolOutputs["people.approve"] = () => refusal("not_admin", "Only an admin can approve or reject people.");
    const result = await run(["approve", cory.id, "--json"]);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, status: "error", code: "not_admin", message: "Only an admin can approve or reject people." });
  });
});

describe("draft people notify", () => {
  test("resolves a name to an active person and prints one line per channel", async () => {
    let seen: Record<string, unknown> = {};
    backend.state.toolOutputs["people.find"] = () => ({ people: [uzo] });
    backend.state.toolOutputs["people.notify"] = (input) => { seen = input; return { results: [{ channel: "slack", status: "sent" }] }; };
    const result = await run(["notify", "uzo", "Your", "items", "are", "ready", "--link", "https://app.example/x"]);
    expect(result.exitCode).toBe(0);
    expect(seen).toEqual({ personId: ID, text: "Your items are ready", link: "https://app.example/x" });
    expect(result.stdout).toBe("slack: sent");
  });

  test("exits 1 when nothing was sent", async () => {
    backend.state.toolOutputs["people.notify"] = () => ({ results: [{ channel: "slack", status: "failed", code: "not_reachable" }] });
    const result = await run(["notify", ID, "hello"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not sent (not_reachable)");
  });

  test("needs a person and a message", async () => {
    expect((await run(["notify", "uzo"])).exitCode).toBe(2);
  });
});

describe("draft people", () => {
  test("an unknown subcommand is invalid usage", async () => {
    expect((await run(["wat"])).exitCode).toBe(2);
  });

  test("not being signed in points at login", async () => {
    rmSync(home, { recursive: true, force: true });
    home = makeHome();
    const result = await run(["find", "--json"]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "not_authenticated", action: "draft auth login" });
  });
});

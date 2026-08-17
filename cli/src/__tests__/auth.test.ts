import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "fs";
import { join } from "path";
import { createMockBackend, defaultWhoami } from "./helpers/mock-backend.ts";
import { makeHome, runCli, seedCliAuth } from "./helpers/cli-runner.ts";

let backend: ReturnType<typeof createMockBackend>;
let home: string;

beforeEach(() => {
  backend = createMockBackend();
  home = makeHome();
});
afterEach(() => {
  backend.stop();
  rmSync(home, { recursive: true, force: true });
});

function parseJsonLines(stdout: string): unknown[] {
  return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("draft auth login", () => {
  test("fresh pairing: JSONL — one pairing_required line, then one terminal authenticated line", async () => {
    backend.state.linkPollResponses = [() => Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 })];
    backend.state.whoamiResponse = () => defaultWhoami({ organization_id: "org-1", primary_team_id: "team-1", workspace_id: "ws-1" });

    const result = await runCli(["auth", "login", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("\x1b[");
    const lines = parseJsonLines(result.stdout);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ schema_version: 1, status: "pairing_required" });
    expect((lines[0] as { url: string }).url).toContain("/link?code=");
    expect(lines[1]).toMatchObject({ schema_version: 1, status: "authenticated", organization_id: "org-1", team_id: "team-1", workspace_id: "ws-1" });

    const stored = JSON.parse(readFileSync(join(home, ".draft", "personal", "cli-auth.json"), "utf8"));
    expect(stored).toMatchObject({ access_token: "at", refresh_token: "rt", identity_resolved: true, workspace_id: "ws-1" });
  });

  test("human mode always prints the pairing URL", async () => {
    backend.state.linkPollResponses = [() => Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 })];
    const result = await runCli(["auth", "login"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Open this URL to sign in:");
    expect(result.stdout).toContain("/link?code=");
  });

  test("expired pairing surfaces an error and exits nonzero", async () => {
    backend.state.linkPollResponses = [() => new Response(null, { status: 404 })];
    const result = await runCli(["auth", "login", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    const lines = parseJsonLines(result.stdout);
    expect(lines[lines.length - 1]).toMatchObject({ status: "error", code: "expired" });
  });

  test("session reuse: valid stored session skips pairing entirely", async () => {
    seedCliAuth(home);
    backend.state.whoamiResponse = () => defaultWhoami({ workspace_id: "ws-reused" });
    const result = await runCli(["auth", "login", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    const lines = parseJsonLines(result.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: "authenticated", workspace_id: "ws-reused" });
  });

  test("--force always starts a new pairing flow even with a valid stored session", async () => {
    seedCliAuth(home, { access_token: "stale-at" });
    backend.state.linkPollResponses = [() => Response.json({ access_token: "forced-at", refresh_token: "forced-rt", expires_in: 3600 })];
    const result = await runCli(["auth", "login", "--force", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    const lines = parseJsonLines(result.stdout);
    expect(lines[0]).toMatchObject({ status: "pairing_required" });
    const stored = JSON.parse(readFileSync(join(home, ".draft", "personal", "cli-auth.json"), "utf8"));
    expect(stored.access_token).toBe("forced-at");
  });

  test("dead stored session (terminal) falls through to a fresh pairing flow", async () => {
    seedCliAuth(home);
    backend.state.whoamiResponse = () => new Response(null, { status: 401 });
    backend.state.linkPollResponses = [() => Response.json({ access_token: "recovered-at", refresh_token: "recovered-rt", expires_in: 3600 })];
    backend.state.refreshResponse = () => new Response(null, { status: 401 }); // refresh also terminal
    const result = await runCli(["auth", "login", "--json"], { home, apiUrl: backend.url });
    const lines = parseJsonLines(result.stdout);
    expect(lines.some((l) => (l as { status?: string }).status === "pairing_required")).toBe(true);
  });

  test("unknown flag is invalid usage, exit 2", async () => {
    const result = await runCli(["auth", "login", "--bogus"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(2);
  });

  test("SIGINT during pairing aborts cleanly and exits 130", async () => {
    // Poll never resolves — keeps the CLI waiting so we can interrupt it mid-flight.
    const proc = Bun.spawn({
      cmd: ["bun", "run", join(import.meta.dir, "..", "index.ts"), "auth", "login", "--json"],
      env: {
        ...process.env,
        HOME: home,
        DRAFT_API_BASE_URL: backend.url,
        DRAFT_APP_URL: backend.url,
        DRAFT_SUPABASE_URL: backend.url,
        DRAFT_SUPABASE_PUBLISHABLE_KEY: "test-anon-key",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for the pairing_required line to know polling has started.
    const reader = proc.stdout.getReader();
    let buffered = "";
    const decoder = new TextDecoder();
    while (!buffered.includes("pairing_required")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value);
    }
    reader.releaseLock();

    proc.kill("SIGINT");
    const exitCode = await proc.exited;
    expect(exitCode).toBe(130);
  }, 15_000);
});

describe("draft auth whoami", () => {
  test("not signed in — action points to draft auth login, exit 1", async () => {
    const result = await runCli(["auth", "whoami", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "not_authenticated", action: "draft auth login" });
  });

  test("always calls the hosted API live, refreshes cached fields", async () => {
    seedCliAuth(home, { organization_id: "stale-org", workspace_id: "stale-ws" });
    backend.state.whoamiResponse = () => defaultWhoami({ organization_id: "fresh-org", workspace_id: "fresh-ws" });
    const result = await runCli(["auth", "whoami", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, organization_id: "fresh-org", team_id: null, workspace_id: "fresh-ws", onboarding_completed_at: null });
    const stored = JSON.parse(readFileSync(join(home, ".draft", "personal", "cli-auth.json"), "utf8"));
    expect(stored.workspace_id).toBe("fresh-ws");
  });

  test("expired access token triggers a refresh via the shared refresh flow", async () => {
    seedCliAuth(home, { expires_at: Math.floor(Date.now() / 1000) - 10 });
    backend.state.refreshResponse = () => Response.json({ access_token: "refreshed-at", refresh_token: "refreshed-rt", expires_in: 3600 });
    backend.state.whoamiResponse = () => defaultWhoami({ workspace_id: "post-refresh-ws" });
    const result = await runCli(["auth", "whoami", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).workspace_id).toBe("post-refresh-ws");
  });

  test("terminal refresh failure clears credentials and reports not_authenticated", async () => {
    seedCliAuth(home, { expires_at: Math.floor(Date.now() / 1000) - 10 });
    backend.state.refreshResponse = () => new Response(null, { status: 401 });
    const result = await runCli(["auth", "whoami", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).code).toBe("not_authenticated");
  });
});

describe("draft auth logout", () => {
  test("clean logout clears local credentials, exit 0", async () => {
    seedCliAuth(home);
    const result = await runCli(["auth", "logout", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ schema_version: 1, status: "logged_out" });
    expect(() => readFileSync(join(home, ".draft", "personal", "cli-auth.json"))).toThrow();
  });

  test("logout with no stored session still succeeds", async () => {
    const result = await runCli(["auth", "logout", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
  });

  test("partial logout: revoke fails but local store is still cleared, exit nonzero", async () => {
    seedCliAuth(home);
    backend.state.logoutResponse = () => new Response(null, { status: 500 });
    const result = await runCli(["auth", "logout", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "partial_logout" });
    expect(() => readFileSync(join(home, ".draft", "personal", "cli-auth.json"))).toThrow();
  });
});

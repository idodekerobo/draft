import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "path";
import {
  GithubInstallPollError,
  pollGithubInstall,
} from "draft-core/github-install-poll";
import { createIntegrationOutput } from "../integrations/safe-output.ts";
import {
  runGithubConnect,
  type GithubConnectDeps,
} from "../integrations/providers/github.ts";
import { createMockBackend, defaultWhoami } from "./helpers/mock-backend.ts";
import { makeHome, runCli, seedCliAuth } from "./helpers/cli-runner.ts";

const installUrl = "https://github.com/apps/draft-context-test/installations/new?state=install-code";

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

function dependencies(overrides: Partial<GithubConnectDeps> = {}) {
  const launches: string[] = [];
  const handlers = new Map<string, () => void>();
  const deps: GithubConnectDeps = {
    createSession: async () => ({
      ok: true,
      value: { code: "install-code", installUrl, originWorkspaceId: "ws-1" },
    }),
    createPollAdapter: () => ({
      failureCode: () => undefined,
      fetch: (async () => Response.json({ status: "connected" })) as unknown as typeof fetch,
    }),
    poll: async () => ({ status: "connected" }),
    launcher: {
      launchBrowser: async (url) => {
        launches.push(url);
        return { opened: true };
      },
    },
    onSignal: (signal, handler) => { handlers.set(signal, handler); },
    offSignal: (signal) => { handlers.delete(signal); },
    ...overrides,
  };
  return { deps, launches, handlers };
}

describe("GitHub connect provider", () => {
  it("emits exact JSONL and --no-open changes only browser launch behavior", async () => {
    const opened = dependencies();
    const openedOutput = output(true);
    expect(await runGithubConnect({ noOpen: false }, openedOutput.value, opened.deps)).toBe(0);
    expect(opened.launches).toEqual([installUrl]);

    const noOpen = dependencies();
    const noOpenOutput = output(true);
    expect(await runGithubConnect({ noOpen: true }, noOpenOutput.value, noOpen.deps)).toBe(0);
    expect(noOpen.launches).toEqual([]);
    expect(noOpenOutput.stdout.join("")).toBe(openedOutput.stdout.join(""));
    expect(noOpenOutput.stderr.join("")).toBe(openedOutput.stderr.join(""));
    expect(openedOutput.stdout.map((line) => JSON.parse(line))).toEqual([
      {
        schema_version: 1,
        status: "browser_required",
        provider: "github",
        url: installUrl,
        expires_in_seconds: 300,
      },
      { schema_version: 1, status: "awaiting_install", provider: "github" },
      { schema_version: 1, status: "connected", provider: "github" },
    ]);
    expect(opened.handlers.size).toBe(0);
  });

  it("prints the reviewed URL and final status in human mode", async () => {
    const harness = dependencies();
    const terminal = output(false);
    expect(await runGithubConnect({ noOpen: true }, terminal.value, harness.deps)).toBe(0);
    expect(terminal.stderr.join("")).toBe(
      `Open this URL: ${installUrl}\n`
      + "Install the Draft GitHub App and select the repositories to grant it access to.\n"
      + "Waiting for installation.\n",
    );
    expect(terminal.stdout.join("")).toBe("GitHub: connected\n");
  });

  it("continues polling when the default browser launch fails", async () => {
    const harness = dependencies({
      launcher: { launchBrowser: async () => ({ opened: false }) },
    });
    const rendered = output(true);
    expect(await runGithubConnect({ noOpen: false }, rendered.value, harness.deps)).toBe(0);
    expect(rendered.stdout.map((line) => JSON.parse(line).status)).toEqual(["browser_required", "awaiting_install", "connected"]);
  });

  it("aborts a hung session creation through the threaded signal", async () => {
    let receivedSignal: AbortSignal | undefined;
    const harness = dependencies({
      createSession: (signal) => {
        receivedSignal = signal;
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ ok: false, code: "aborted" }), { once: true });
        });
      },
    });
    const rendered = output(true);
    const pending = runGithubConnect({ noOpen: false }, rendered.value, harness.deps);
    await Bun.sleep(0);
    harness.handlers.get("SIGINT")?.();
    expect(await pending).toBe(130);
    expect(receivedSignal?.aborted).toBe(true);
    expect(harness.launches).toEqual([]);
    expect(rendered.stdout.map((line) => JSON.parse(line).status)).toEqual(["error"]);
  });

  it("does not let a hung browser launcher delay interruption or start polling", async () => {
    let pollCalls = 0;
    const harness = dependencies({
      launcher: { launchBrowser: () => new Promise(() => undefined) },
      poll: async () => { pollCalls++; return { status: "connected" }; },
    });
    const rendered = output(true);
    const pending = runGithubConnect({ noOpen: false }, rendered.value, harness.deps);
    for (let attempt = 0; attempt < 20 && rendered.stdout.length === 0; attempt++) await Bun.sleep(1);
    harness.handlers.get("SIGINT")?.();
    expect(await pending).toBe(130);
    expect(pollCalls).toBe(0);
    expect(rendered.stdout.map((line) => JSON.parse(line).status)).toEqual(["browser_required", "error"]);
  });

  it("walks pending to connected through the shared poller", async () => {
    let polls = 0;
    const harness = dependencies({
      createPollAdapter: () => ({
        failureCode: () => undefined,
        fetch: (async () => Response.json({ status: ++polls === 1 ? "pending" : "connected" })) as unknown as typeof fetch,
      }),
      poll: (input) => pollGithubInstall({ ...input, pollIntervalMs: 1, deadlineMs: 100 }),
    });
    const rendered = output(true);
    expect(await runGithubConnect({ noOpen: true }, rendered.value, harness.deps)).toBe(0);
    expect(polls).toBe(2);
    expect(rendered.stdout.map((line) => JSON.parse(line).status)).toEqual(["browser_required", "awaiting_install", "connected"]);
  });

  it("maps safe polling failures and never renders terminal backend detail", async () => {
    const cases: Array<{
      poll: GithubConnectDeps["poll"];
      code: string;
    }> = [
      { poll: async () => { throw new GithubInstallPollError("expired"); }, code: "expired" },
      { poll: async () => { throw new GithubInstallPollError("forbidden"); }, code: "forbidden" },
      { poll: async () => { throw new GithubInstallPollError("timed_out"); }, code: "timed_out" },
      { poll: async () => { throw new GithubInstallPollError("malformed_response"); }, code: "malformed_response" },
      { poll: async () => { throw new Error("raw-transport-canary"); }, code: "poll_failed" },
      { poll: async () => ({ status: "error", errorCode: "github_installation_conflict", message: "raw-conflict-canary" }), code: "github_installation_conflict" },
      { poll: async () => ({ status: "error", errorCode: "github_callback_failed", message: "raw-generic-canary" }), code: "poll_failed" },
    ];
    for (const testCase of cases) {
      const harness = dependencies({ poll: testCase.poll });
      const rendered = output(true);
      expect(await runGithubConnect({ noOpen: true }, rendered.value, harness.deps)).not.toBe(0);
      const lines = rendered.stdout.map((line) => JSON.parse(line));
      expect(lines.at(-1)).toMatchObject({ status: "error", code: testCase.code });
      expect(rendered.stdout.join("")).not.toContain("raw-");
    }
  });

  it("maps adapter workspace failures before generic poll errors", async () => {
    const harness = dependencies({
      createPollAdapter: () => ({
        failureCode: () => "workspace_changed",
        fetch: (async () => { throw new Error("must-not-render"); }) as unknown as typeof fetch,
      }),
      poll: async () => { throw new GithubInstallPollError("poll_failed"); },
    });
    const rendered = output(true);
    expect(await runGithubConnect({ noOpen: true }, rendered.value, harness.deps)).toBe(1);
    expect(JSON.parse(rendered.stdout.at(-1)!)).toMatchObject({ status: "error", code: "workspace_changed" });
  });
});

describe("draft integrations connect github", () => {
  let backend: ReturnType<typeof createMockBackend>;
  let home: string;

  beforeEach(() => {
    backend = createMockBackend();
    home = makeHome();
    seedCliAuth(home);
  });

  afterEach(() => backend.stop());

  it("uses one fresh coherent tuple per poll and only the origin workspace/code path", async () => {
    let polls = 0;
    backend.state.githubInstallPollResponse = () => {
      polls++;
      if (polls === 1) {
        seedCliAuth(home, { access_token: "poll-token-2", refresh_token: "poll-refresh-2" });
        return Response.json({ status: "pending" });
      }
      return Response.json({ status: "connected" });
    };

    const result = await runCli(["integrations", "connect", "github", "--no-open", "--json"], {
      home,
      apiUrl: backend.url,
      timeoutMs: 8_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n").map((line) => JSON.parse(line))).toEqual([
      {
        schema_version: 1,
        status: "browser_required",
        provider: "github",
        url: installUrl,
        expires_in_seconds: 300,
      },
      { schema_version: 1, status: "awaiting_install", provider: "github" },
      { schema_version: 1, status: "connected", provider: "github" },
    ]);
    const pollRequests = backend.state.requests.filter((request) =>
      new URL(request.url).pathname.includes("/github/install-sessions/install-code")
    );
    expect(pollRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/workspaces/ws-1/github/install-sessions/install-code",
      "/workspaces/ws-1/github/install-sessions/install-code",
    ]);
    expect(pollRequests.map((request) => request.headers.authorization)).toEqual([
      "Bearer seed-at",
      "Bearer poll-token-2",
    ]);
    expect(backend.state.requests.filter((request) => new URL(request.url).pathname === "/whoami")).toHaveLength(3);
  });

  it("rejects a changed workspace before issuing the poll GET", async () => {
    let identities = 0;
    backend.state.whoamiResponse = () => Response.json({
      organization_id: null,
      primary_team_id: null,
      workspace_id: ++identities === 1 ? "ws-1" : "ws-2",
      onboarding_completed_at: null,
    });
    const result = await runCli(["integrations", "connect", "github", "--no-open", "--json"], {
      home,
      apiUrl: backend.url,
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.split("\n").at(-1)!)).toMatchObject({ status: "error", code: "workspace_changed" });
    expect(backend.state.requests.some((request) =>
      new URL(request.url).pathname.includes("/github/install-sessions/install-code")
    )).toBe(false);
  });

  it("rejects invalid grammar before any request", async () => {
    const cases = [
      ["integrations", "connect"],
      ["integrations", "connect", "github", "extra"],
      ["integrations", "connect", "github", "--json", "--json"],
      ["integrations", "connect", "github", "--no-open", "--no-open"],
      ["integrations", "connect", "github", "--credential-stdin"],
      ["integrations", "connect", "github", "--credential-fd", "3"],
      ["integrations", "connect", "unknown-provider"],
      ["integrations", "connect", "--json", "github"],
    ];
    for (const args of cases) {
      const result = await runCli(args, { home, apiUrl: backend.url });
      expect(result.exitCode).toBe(2);
    }
    expect(backend.state.requests).toEqual([]);
  });

  it("handles SIGINT once and stops before a later poll request", async () => {
    backend.state.githubInstallPollResponse = () => Response.json({ status: "pending" });
    const cliEntry = join(import.meta.dir, "..", "index.ts");
    const child = Bun.spawn({
      cmd: ["bun", "run", cliEntry, "integrations", "connect", "github", "--no-open", "--json"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        DRAFT_API_BASE_URL: backend.url,
        DRAFT_APP_URL: backend.url,
        DRAFT_SUPABASE_URL: backend.url,
        DRAFT_SUPABASE_PUBLISHABLE_KEY: "test-anon-key",
      },
    });
    for (let attempt = 0; attempt < 100 && !backend.state.requests.some((request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/github/install-sessions")); attempt++) {
      await Bun.sleep(5);
    }
    await Bun.sleep(20);
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    const stdout = await new Response(child.stdout).text();
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.status)).toEqual(["browser_required", "awaiting_install", "error"]);
    expect(lines.at(-1)).toMatchObject({ code: "aborted" });
    await Bun.sleep(20);
    expect(backend.state.requests.some((request) =>
      new URL(request.url).pathname.includes("/github/install-sessions/install-code")
    )).toBe(false);
  });

  it("does not hang forever when a mid-poll /whoami request never responds", async () => {
    let whoamiCalls = 0;
    let releaseHungWhoami: (() => void) | undefined;
    backend.state.whoamiResponse = () => {
      whoamiCalls++;
      if (whoamiCalls === 1) return defaultWhoami();
      return new Promise<Response>((resolve) => {
        releaseHungWhoami = () => resolve(defaultWhoami());
      });
    };
    backend.state.githubInstallPollResponse = () => Response.json({ status: "pending" });
    const cliEntry = join(import.meta.dir, "..", "index.ts");
    const child = Bun.spawn({
      cmd: ["bun", "run", cliEntry, "integrations", "connect", "github", "--no-open", "--json"],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: home,
        DRAFT_API_BASE_URL: backend.url,
        DRAFT_APP_URL: backend.url,
        DRAFT_SUPABASE_URL: backend.url,
        DRAFT_SUPABASE_PUBLISHABLE_KEY: "test-anon-key",
      },
    });
    for (let attempt = 0; attempt < 600 && whoamiCalls < 2; attempt++) await Bun.sleep(10);
    expect(whoamiCalls).toBeGreaterThanOrEqual(2);
    child.kill("SIGINT");
    expect(await child.exited).toBe(130);
    const stdout = await new Response(child.stdout).text();
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.status)).toEqual(["browser_required", "awaiting_install", "error"]);
    expect(lines.at(-1)).toMatchObject({ code: "aborted" });
    releaseHungWhoami?.();
  }, 15_000);
});

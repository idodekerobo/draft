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

function rawConnection(
  provider: string,
  status: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    provider,
    status,
    display_name: null,
    last_success_at: null,
    last_error_at: null,
    ...(provider === "slack" ? { channel_ids: [] } : {}),
    ...overrides,
  };
}

function providerRequests() {
  return backend.state.requests.filter((request) =>
    new URL(request.url).pathname.includes("/connections")
  );
}

const SAMPLE_INTEGRATIONS = [
  {
    provider: "github",
    label: "GitHub",
    status: "connected",
    connectedByYou: true,
    ingests: "pull requests and commits",
    triggers: [{ event: "github.pull_request", label: "Pull request opened" }],
    abilities: ["A routine can read repos, or open pull requests in them"],
    connect: { cli: "draft connections connect github", mcp: 'connections.connect {"provider":"github"}' },
  },
  {
    provider: "slack",
    label: "Slack",
    status: "needs_reconnect",
    connectedByYou: false,
    ingests: "messages in the channels you pick",
    triggers: [],
    abilities: ["A routine can post in channels"],
    connect: { cli: "draft connections connect slack", mcp: 'connections.connect {"provider":"slack"}' },
  },
  {
    provider: "linear",
    label: "Linear",
    status: "not_connected",
    connectedByYou: false,
    ingests: "issues, comments and projects",
    triggers: [],
    abilities: [],
    connect: { cli: "draft connections connect linear", mcp: 'connections.connect {"provider":"linear"}' },
  },
];

describe("draft connections list", () => {
  it("passes the connections.list tool output through unchanged as JSON", async () => {
    backend.state.toolOutputs["connections.list"] = () => ({ connections: SAMPLE_INTEGRATIONS });

    const result = await runCli(["connections", "list", "--json"], { home, apiUrl: backend.url });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(JSON.stringify({ connections: SAMPLE_INTEGRATIONS }));
    expect(backend.state.requests.some((request) => new URL(request.url).pathname === "/workspaces/ws-1/tools/connections.list")).toBe(true);
  });

  it("prints one block per provider with status, what it unlocks, and the connect command", async () => {
    backend.state.toolOutputs["connections.list"] = () => ({ connections: SAMPLE_INTEGRATIONS });

    const result = await runCli(["connections", "list"], { home, apiUrl: backend.url });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe([
      "GitHub: connected (you)",
      "  brings in: pull requests and commits",
      "  unlocks triggers: Pull request opened",
      "  lets routines: A routine can read repos, or open pull requests in them",
      "",
      "Slack: needs reconnect",
      "  brings in: messages in the channels you pick",
      "  lets routines: A routine can post in channels",
      "  connect: draft connections connect slack",
      "",
      "Linear: not connected",
      "  brings in: issues, comments and projects",
      "  connect: draft connections connect linear",
    ].join("\n"));
    expect(result.stderr).toBe("");
  });

  it("returns the tool's refusal as a safe error, without its raw text", async () => {
    backend.state.toolOutputs["connections.list"] = () => ({ __refusal: { code: "forbidden", message: "forbidden-canary-message" } });

    const result = await runCli(["connections", "list", "--json"], { home, apiUrl: backend.url });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "forbidden" });
    expect(`${result.stdout}${result.stderr}`).not.toContain("canary");
  });

  it("reports a malformed tool output as malformed_response", async () => {
    backend.state.toolOutputs["connections.list"] = () => ({ connections: "malformed-canary" });

    const result = await runCli(["connections", "list", "--json"], { home, apiUrl: backend.url });

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "malformed_response" });
    expect(`${result.stdout}${result.stderr}`).not.toContain("canary");
  });
});

describe("draft connections disconnect", () => {
  it.each(["github", "fireflies", "linear", "slack"] as const)(
    "maps %s exactly in JSON and human mode, including idempotent success",
    async (provider) => {
      backend.state.connectionsDisconnectResponse = () => Response.json({
        ok: true,
        already_revoked: true,
        raw_detail: "must-not-pass-through",
      });

      const json = await runCli(["connections", "disconnect", provider, "--json"], { home, apiUrl: backend.url });
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({
        schema_version: 1,
        status: "disconnected",
        provider,
      });
      expect(json.stderr).toBe("");

      const human = await runCli(["connections", "disconnect", provider], { home, apiUrl: backend.url });
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toBe(`${provider === "github" ? "GitHub" : provider[0]!.toUpperCase() + provider.slice(1)}: disconnected`);
      expect(human.stderr).toBe("");

      const requests = providerRequests();
      expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
        ["DELETE", `/workspaces/ws-1/connections/${provider}`],
        ["DELETE", `/workspaces/ws-1/connections/${provider}`],
      ]);
    },
  );
});

describe("draft connections grammar and safe failures", () => {
  it("rejects invalid grammar before any provider request", async () => {
    const cases = [
      ["connections"],
      ["connections", "unknown", "--json", "--json"],
      ["connections", "list", "extra"],
      ["connections", "list", "--json", "--json"],
      ["connections", "list", "--unknown"],
      ["connections", "disconnect"],
      ["connections", "disconnect", "github", "extra"],
      ["connections", "disconnect", "future-provider"],
      ["connections", "disconnect", "slack", "--json", "--json"],
      ["connections", "disconnect", "slack", "--unknown"],
    ];
    for (const args of cases) {
      const result = await runCli(args, { home, apiUrl: backend.url });
      expect(result.exitCode).toBe(2);
      if (args.includes("--json")) {
        expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "invalid_usage" });
      }
    }
    expect(backend.state.requests).toHaveLength(0);
  });

  it("disconnects claude-code deterministically as not_supported, without a network call", async () => {
    const result = await runCli(["connections", "disconnect", "claude-code", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "not_supported" });
    expect(backend.state.requests).toHaveLength(0);
  });

  it("returns safe auth and workspace errors", async () => {
    const bareHome = makeHome();
    try {
      const unauthenticated = await runCli(["connections", "list", "--json"], {
        home: bareHome,
        apiUrl: backend.url,
      });
      expect(unauthenticated.exitCode).toBe(1);
      expect(JSON.parse(unauthenticated.stdout)).toEqual({
        schema_version: 1,
        status: "error",
        code: "not_authenticated",
        message: "Not signed in.",
        action: "draft auth login",
      });
    } finally {
      rmSync(bareHome, { recursive: true, force: true });
    }

    backend.state.whoamiResponse = () => Response.json({
      organization_id: null,
      primary_team_id: null,
      workspace_id: null,
      onboarding_completed_at: null,
    });
    const noWorkspace = await runCli(["connections", "list", "--json"], { home, apiUrl: backend.url });
    expect(noWorkspace.exitCode).toBe(1);
    expect(JSON.parse(noWorkspace.stdout)).toMatchObject({ status: "error", code: "no_workspace" });
  });
});

describe("connections help and completion", () => {
  it("lists only the exposed integrations commands in top-level help", async () => {
    const result = await runCli(["--help"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("connections list");
    expect(result.stdout).toContain("connections connect <provider>");
    expect(result.stdout).toContain("connections disconnect <provider>");
    expect(result.stdout).toContain("connections slack channels list|set");
    expect(result.stdout).toContain("Connect github, slack, linear, fireflies, granola, or claude-code");
  });

  it("lists every integrations subcommand with a pointer to per-command help", async () => {
    const result = await runCli(["connections", "--help"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    for (const command of ["list", "connect <provider>", "disconnect <provider>", "slack channels list|set"]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toContain("Run `draft connections <command> --help` for details.");
  });

  it.each(["list", "connect", "disconnect", "slack"])("prints full usage for integrations %s --help", async (subcommand) => {
    const result = await runCli(["connections", subcommand, "--help"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Usage: draft connections ${subcommand}`);
    expect(result.stdout).toContain("Examples:");
  });

  it("connect --help names every provider and explains the agent link flow", async () => {
    const result = await runCli(["connections", "connect", "--help"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("github, slack, linear, fireflies, granola, claude-code");
    expect(result.stdout).toContain("With --json or without a terminal it prints a link for the person to open;");
    expect(result.stdout).toContain("the key never passes through the CLI. Add --wait to wait until connected.");
  });

  it("auth login --help documents the sign-in code and JSON output", async () => {
    const result = await runCli(["auth", "login", "--help"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: draft auth login");
    expect(result.stdout).toContain('"action":"sign_in"');
    expect(result.stdout).toContain("type it on the");
  });

  it("includes current top-level commands and integrations choices in bash and zsh completion", async () => {
    const bash = await runCli(["completion"], { home, apiUrl: backend.url });
    expect(bash.exitCode).toBe(0);
    expect(bash.stdout).toContain('commands="add auth context people routines activity sources sessions skills connections update uninstall completion"');
    expect(bash.stdout).toContain('compgen -W "list connect disconnect slack"');
    expect(bash.stdout).toContain('compgen -W "github slack linear fireflies granola claude-code"');
    expect(bash.stdout).toContain('compgen -W "list options create update delete run runs"');
    expect(bash.stdout).toContain('connections:connect) flags="--json --wait --no-open');
    expect(bash.stdout).toContain('routines:*) flags="--on --github --github-access');
    expect(bash.stdout).toContain('compgen -W "github slack linear fireflies granola"');

    const zsh = await runCli(["completion", "--zsh"], { home, apiUrl: backend.url });
    expect(zsh.exitCode).toBe(0);
    for (const command of ["add:", "auth:", "context:", "people:", "sources:", "sessions:", "skills:", "connections:", "update:", "completion:"]) {
      expect(zsh.stdout).toContain(`'${command}`);
    }
    expect(zsh.stdout).toContain("'list:Show each connection and what it unlocks'");
    expect(zsh.stdout).toContain("'connect:Connect a hosted connection'");
    expect(zsh.stdout).toContain("'disconnect:Disconnect a hosted connection'");
    expect(zsh.stdout).toContain("'github:GitHub'");
    expect(zsh.stdout).toContain("'claude-code:Claude Code'");
    expect(zsh.stdout).toContain("'--wait[Wait until connected]'");
    expect(zsh.stdout).toContain("'runs:List the runs of a routine'");
    expect(zsh.stdout).toContain("'--github-access=[GitHub access level]:access:'");
    expect(zsh.stdout).toContain("'fireflies:Fireflies'");
    expect(zsh.stdout).toContain("'linear:Linear'");
    expect(zsh.stdout).toContain("'slack:Slack'");
    expect(zsh.stdout).toContain("'granola:Granola'");
  });
});

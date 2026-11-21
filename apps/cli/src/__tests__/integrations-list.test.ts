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
  const disconnectRequests = () => backend.state.requests
    .filter((request) => new URL(request.url).pathname.endsWith("/tools/connections.disconnect"))
    .map((request) => JSON.parse(request.body));

  const label = (provider: string) => (provider === "github" ? "GitHub" : provider[0]!.toUpperCase() + provider.slice(1));

  it.each(["github", "fireflies", "linear", "slack"] as const)(
    "reports what %s would stop and changes nothing without --yes",
    async (provider) => {
      backend.state.toolOutputs["connections.disconnect"] = () => ({
        status: "confirmation_required",
        provider,
        connectedByYou: true,
        stops: { ingests: "things", triggers: [], abilities: [] },
        message: `Disconnecting ${label(provider)} stops new items from coming in. To go ahead, call connections.disconnect again with {"provider":"${provider}","confirm":true}.`,
      });

      const json = await runCli(["connections", "disconnect", "--provider", provider, "--json"], { home, apiUrl: backend.url });
      expect(json.exitCode).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({
        schema_version: 1,
        status: "confirmation_required",
        provider,
        confirm_with: `draft connections disconnect --provider ${provider} --yes`,
      });

      const human = await runCli(["connections", "disconnect", "--provider", provider], { home, apiUrl: backend.url });
      expect(human.exitCode).toBe(1);
      expect(human.stderr).toContain(`Disconnecting ${label(provider)} stops new items from coming in.`);
      expect(human.stderr).toContain(`To go ahead, run: draft connections disconnect --provider ${provider} --yes`);
      expect(human.stderr).not.toContain("connections.disconnect again");
      expect(disconnectRequests()).toEqual([{ provider }, { provider }]);
    },
  );

  it.each(["github", "fireflies", "linear", "slack"] as const)("disconnects %s with --yes, in JSON and human mode", async (provider) => {
    backend.state.toolOutputs["connections.disconnect"] = () => ({ status: "disconnected", provider, message: `${label(provider)} is disconnected.` });

    const json = await runCli(["connections", "disconnect", "--provider", provider, "--yes", "--json"], { home, apiUrl: backend.url });
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ schema_version: 1, status: "disconnected", provider });
    expect(json.stderr).toBe("");

    const human = await runCli(["connections", "disconnect", "--provider", provider, "--yes"], { home, apiUrl: backend.url });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toBe(`Disconnected: ${label(provider)}.`);
    expect(disconnectRequests()).toEqual([{ provider, confirm: true }, { provider, confirm: true }]);
  });

  it("sends Granola's account kind", async () => {
    backend.state.toolOutputs["connections.disconnect"] = () => ({ status: "disconnected", provider: "granola" });
    await runCli(["connections", "disconnect", "--provider", "granola", "--workspace-key", "--yes", "--json"], { home, apiUrl: backend.url });
    await runCli(["connections", "disconnect", "--provider", "granola", "--yes", "--json"], { home, apiUrl: backend.url });
    expect(disconnectRequests()).toEqual([
      { provider: "granola", accountKind: "workspace", confirm: true },
      { provider: "granola", accountKind: "personal", confirm: true },
    ]);
  });

  it("says so when the provider is not connected, and succeeds", async () => {
    backend.state.toolOutputs["connections.disconnect"] = () => ({ status: "not_connected", provider: "linear", message: "Linear is not connected." });
    const result = await runCli(["connections", "disconnect", "--provider", "linear", "--yes"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Linear is not connected.");
  });

  it("shows the tool's refusal when someone else connected it", async () => {
    backend.state.toolOutputs["connections.disconnect"] = () => ({ __refusal: { code: "not_connection_owner", message: "Only the person who connected Slack can disconnect it." } });
    const result = await runCli(["connections", "disconnect", "--provider", "slack", "--yes"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Only the person who connected Slack can disconnect it.");
  });
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
      ["connections", "disconnect", "--provider", "github", "extra"],
      ["connections", "disconnect", "--provider", "future-provider"],
      ["connections", "disconnect", "--provider", "slack", "--json", "--json"],
      ["connections", "disconnect", "--provider", "slack", "--unknown"],
      ["connections", "disconnect", "--provider", "slack", "--workspace-key"],
      ["connections", "disconnect", "slack"],
      ["connections", "list", "--provider"],
      ["connections", "list", "--provider", "future-provider"],
      ["connections", "read", "--provider", "slack"],
      ["connections", "read", "--provider", "slack", "--channel", "C1", "--limit", "0"],
      ["connections", "post", "--provider", "slack", "--channel", "C1"],
      ["connections", "post", "--provider", "slack", "--channel", "C1", "--text", "  "],
      ["connections", "post", "slack", "C1", "hello"],
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
    const result = await runCli(["connections", "disconnect", "--provider", "claude-code", "--json"], { home, apiUrl: backend.url });
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
    expect(result.stdout).toContain("connections connect --provider <provider>");
    expect(result.stdout).toContain("connections disconnect --provider <provider>");
    expect(result.stdout).toContain("connections read --provider <provider>");
    expect(result.stdout).toContain("connections post --provider <provider>");
    expect(result.stdout).toContain("Connect github, slack, linear, fireflies, granola, or claude-code");
  });

  it("lists every integrations subcommand with a pointer to per-command help", async () => {
    const result = await runCli(["connections", "--help"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    for (const command of ["list", "connect --provider <provider>", "disconnect --provider <provider>", "read --provider <provider>", "post --provider <provider>"]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toContain("Run `draft connections <command> --help` for details.");
  });

  it.each(["list", "connect", "disconnect", "read", "post"])("prints full usage for integrations %s --help", async (subcommand) => {
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
    expect(bash.stdout).toContain('compgen -W "list connect disconnect read post"');
    expect(bash.stdout).toContain('compgen -W "github slack linear fireflies granola claude-code"');
    expect(bash.stdout).toContain('compgen -W "list options create update delete run runs"');
    expect(bash.stdout).toContain('connections:connect) flags="--provider --channels --json --wait --no-open');
    expect(bash.stdout).toContain('connections:read) flags="--provider --channel --limit --json"');
    expect(bash.stdout).toContain('connections:post) flags="--provider --channel --text --json"');
    expect(bash.stdout).toContain('routines:*) flags="--on --github --github-access');
    expect(bash.stdout).toContain('--provider)');

    const zsh = await runCli(["completion", "--zsh"], { home, apiUrl: backend.url });
    expect(zsh.exitCode).toBe(0);
    for (const command of ["add:", "auth:", "context:", "people:", "sources:", "sessions:", "skills:", "connections:", "update:", "completion:"]) {
      expect(zsh.stdout).toContain(`'${command}`);
    }
    expect(zsh.stdout).toContain("'list:Show each connection and what you can do with it'");
    expect(zsh.stdout).toContain("'connect:Connect a provider'");
    expect(zsh.stdout).toContain("'disconnect:Disconnect a provider'");
    expect(zsh.stdout).toContain("'read:Read recent messages from a provider'");
    expect(zsh.stdout).toContain("'post:Post a message through a provider'");
    expect(zsh.stdout).toContain("'--provider[The provider to connect]:provider:(github slack linear fireflies granola claude-code)'");
    expect(zsh.stdout).toContain("'--yes[Confirm and disconnect]'");
    expect(zsh.stdout).toContain("'--wait[Wait until connected]'");
    expect(zsh.stdout).toContain("'runs:List the runs of a routine'");
    expect(zsh.stdout).toContain("'--github-access=[GitHub access level]:access:'");
  });
});

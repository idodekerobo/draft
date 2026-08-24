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

describe("draft integrations list", () => {
  it("returns the exact public JSON shape in fixed order and filters session, unknown, and internal fields", async () => {
    backend.state.connectionsListResponse = () => Response.json({
      connections: [
        rawConnection("claude_session", "active", { display_name: "must-filter" }),
        rawConnection("future_provider", "active", { secret: "unknown-canary" }),
        rawConnection("fireflies", "active", { connection_key: "internal-canary" }),
        rawConnection("linear", "degraded", { last_error_at: "2026-08-20T12:00:00Z" }),
        rawConnection("github", "revoked", { display_name: "Acme", id: "internal-id" }),
        rawConnection("claude_code", "error"),
        rawConnection("slack", "active", {
          display_name: "Workspace",
          last_success_at: "2026-08-20T11:00:00Z",
          channel_ids: ["C1", "C2"],
          config_json: { token: "secret-canary" },
        }),
      ],
    });

    const result = await runCli(["integrations", "list", "--json"], { home, apiUrl: backend.url });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("\x1b[");
    expect(result.stdout).not.toContain("canary");
    expect(JSON.parse(result.stdout)).toEqual({
      schema_version: 1,
      status: "ok",
      connections: [
        {
          provider: "github",
          status: "disconnected",
          connected: false,
          display_name: "Acme",
          last_success_at: null,
          last_error_at: null,
        },
        {
          provider: "slack",
          status: "connected",
          connected: true,
          display_name: "Workspace",
          last_success_at: "2026-08-20T11:00:00Z",
          last_error_at: null,
          channel_ids: ["C1", "C2"],
        },
        {
          provider: "linear",
          status: "degraded",
          connected: true,
          display_name: null,
          last_success_at: null,
          last_error_at: "2026-08-20T12:00:00Z",
        },
        {
          provider: "fireflies",
          status: "pending",
          connected: false,
          display_name: null,
          last_success_at: null,
          last_error_at: null,
        },
        {
          provider: "claude-code",
          status: "error",
          connected: false,
          display_name: null,
          last_success_at: null,
          last_error_at: null,
        },
      ],
    });
  });

  it("synthesizes five disconnected entries when rows are missing", async () => {
    const result = await runCli(["integrations", "list", "--json"], { home, apiUrl: backend.url });
    const connections = JSON.parse(result.stdout).connections;
    expect(connections.map((item: { provider: string }) => item.provider)).toEqual([
      "github",
      "slack",
      "linear",
      "fireflies",
      "claude-code",
    ]);
    expect(connections.every((item: { status: string; connected: boolean }) =>
      item.status === "disconnected" && item.connected === false
    )).toBe(true);
  });

  it.each([
    ["pending", "pending", false],
    ["active", "connected", true],
    ["degraded", "degraded", true],
    ["error", "error", false],
    ["revoked", "disconnected", false],
  ] as const)("normalizes raw %s status", async (rawStatus, status, connected) => {
    backend.state.connectionsListResponse = () => Response.json({
      connections: [rawConnection("github", rawStatus)],
    });
    const result = await runCli(["integrations", "list", "--json"], { home, apiUrl: backend.url });
    const github = JSON.parse(result.stdout).connections[0];
    expect(github).toMatchObject({ provider: "github", status, connected });
  });

  it("uses Fireflies delivery evidence to distinguish pending from connected", async () => {
    backend.state.connectionsListResponse = () => Response.json({
      connections: [rawConnection("fireflies", "active")],
    });
    const pending = await runCli(["integrations", "list", "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(pending.stdout).connections[3]).toMatchObject({ status: "pending", connected: false });

    backend.state.connectionsListResponse = () => Response.json({
      connections: [rawConnection("fireflies", "active", { last_success_at: "2026-08-20T12:00:00Z" })],
    });
    const connected = await runCli(["integrations", "list", "--json"], { home, apiUrl: backend.url });
    expect(JSON.parse(connected.stdout).connections[3]).toMatchObject({ status: "connected", connected: true });

    for (const [rawStatus, status, isConnected] of [
      ["degraded", "degraded", true],
      ["error", "error", false],
      ["revoked", "disconnected", false],
    ] as const) {
      backend.state.connectionsListResponse = () => Response.json({
        connections: [rawConnection("fireflies", rawStatus)],
      });
      const result = await runCli(["integrations", "list", "--json"], { home, apiUrl: backend.url });
      expect(JSON.parse(result.stdout).connections[3]).toMatchObject({ status, connected: isConnected });
    }
  });

  it("prints one stable human line per provider", async () => {
    backend.state.connectionsListResponse = () => Response.json({
      connections: [
        rawConnection("slack", "active"),
        rawConnection("fireflies", "active"),
      ],
    });
    const result = await runCli(["integrations", "list"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe([
      "GitHub: disconnected",
      "Slack: connected",
      "Linear: disconnected",
      "Fireflies: pending",
      "Claude Code: disconnected",
    ].join("\n"));
    expect(result.stderr).toBe("");
  });
});

describe("draft integrations disconnect", () => {
  it.each(["github", "fireflies", "linear", "slack"] as const)(
    "maps %s exactly in JSON and human mode, including idempotent success",
    async (provider) => {
      backend.state.connectionsDisconnectResponse = () => Response.json({
        ok: true,
        already_revoked: true,
        raw_detail: "must-not-pass-through",
      });

      const json = await runCli(["integrations", "disconnect", provider, "--json"], { home, apiUrl: backend.url });
      expect(json.exitCode).toBe(0);
      expect(JSON.parse(json.stdout)).toEqual({
        schema_version: 1,
        status: "disconnected",
        provider,
      });
      expect(json.stderr).toBe("");

      const human = await runCli(["integrations", "disconnect", provider], { home, apiUrl: backend.url });
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

describe("draft integrations grammar and safe failures", () => {
  it("rejects invalid grammar before any provider request", async () => {
    const cases = [
      ["integrations"],
      ["integrations", "unknown", "--json", "--json"],
      ["integrations", "list", "extra"],
      ["integrations", "list", "--json", "--json"],
      ["integrations", "list", "--unknown"],
      ["integrations", "disconnect"],
      ["integrations", "disconnect", "github", "extra"],
      ["integrations", "disconnect", "future-provider"],
      ["integrations", "disconnect", "slack", "--json", "--json"],
      ["integrations", "disconnect", "slack", "--unknown"],
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
    const result = await runCli(["integrations", "disconnect", "claude-code", "--json"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "error", code: "not_supported" });
    expect(backend.state.requests).toHaveLength(0);
  });

  it("returns safe auth and workspace errors", async () => {
    const bareHome = makeHome();
    try {
      const unauthenticated = await runCli(["integrations", "list", "--json"], {
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
    const noWorkspace = await runCli(["integrations", "list", "--json"], { home, apiUrl: backend.url });
    expect(noWorkspace.exitCode).toBe(1);
    expect(JSON.parse(noWorkspace.stdout)).toMatchObject({ status: "error", code: "no_workspace" });
  });

  it("never exposes raw non-2xx or malformed response details", async () => {
    backend.state.connectionsListResponse = () => Response.json({
      error: "provider-canary-code",
      message: "provider-canary-message",
    }, { status: 500 });
    const failed = await runCli(["integrations", "list", "--json"], { home, apiUrl: backend.url });
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: "error", code: "request_failed" });
    expect(`${failed.stdout}${failed.stderr}`).not.toContain("canary");

    backend.state.connectionsListResponse = () => Response.json({
      connections: { raw: "malformed-canary" },
    });
    const malformed = await runCli(["integrations", "list", "--json"], { home, apiUrl: backend.url });
    expect(malformed.exitCode).toBe(1);
    expect(JSON.parse(malformed.stdout)).toMatchObject({ status: "error", code: "malformed_response" });
    expect(`${malformed.stdout}${malformed.stderr}`).not.toContain("canary");
  });
});

describe("integrations help and completion", () => {
  it("lists only the exposed integrations commands in top-level help", async () => {
    const result = await runCli(["--help"], { home, apiUrl: backend.url });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("integrations list");
    expect(result.stdout).toContain("integrations connect <provider>");
    expect(result.stdout).toContain("integrations disconnect <provider>");
  });

  it("includes current top-level commands and integrations choices in bash and zsh completion", async () => {
    const bash = await runCli(["completion"], { home, apiUrl: backend.url });
    expect(bash.exitCode).toBe(0);
    expect(bash.stdout).toContain('commands="add auth context sessions integrations update completion"');
    expect(bash.stdout).toContain('compgen -W "list connect disconnect"');
    expect(bash.stdout).toContain('compgen -W "github"');
    expect(bash.stdout).toContain('compgen -W "github fireflies linear slack"');

    const zsh = await runCli(["completion", "--zsh"], { home, apiUrl: backend.url });
    expect(zsh.exitCode).toBe(0);
    for (const command of ["add:", "auth:", "context:", "sessions:", "integrations:", "update:", "completion:"]) {
      expect(zsh.stdout).toContain(`'${command}`);
    }
    expect(zsh.stdout).toContain("'list:List hosted integrations'");
    expect(zsh.stdout).toContain("'connect:Connect a hosted integration'");
    expect(zsh.stdout).toContain("'disconnect:Disconnect a hosted integration'");
    expect(zsh.stdout).toContain("'github:GitHub'");
    expect(zsh.stdout).toContain("'fireflies:Fireflies'");
    expect(zsh.stdout).toContain("'linear:Linear'");
    expect(zsh.stdout).toContain("'slack:Slack'");
  });
});

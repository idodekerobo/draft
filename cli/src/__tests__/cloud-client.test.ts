import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "fs";
import { join } from "path";
import type { AuthState } from "draft-core/auth-state";
import { normalizeHostedConnections } from "draft-core/integrations/hosted-connections";
import { makeHome, seedCliAuth } from "./helpers/cli-runner.ts";
import { createMockBackend, defaultWhoami } from "./helpers/mock-backend.ts";

const CLOUD_CLIENT = join(import.meta.dir, "..", "cloud-client.ts");
const PROVIDER_PATH = /^\/workspaces\/[^/]+\/(connections|github\/install-sessions)/;

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

async function invoke(
  functionName: string,
  args: unknown[] = [],
  apiUrl = backend.url,
): Promise<Record<string, unknown>> {
  const script = [
    `const client = await import(${JSON.stringify(CLOUD_CLIENT)});`,
    `const result = await client[${JSON.stringify(functionName)}](...${JSON.stringify(args)});`,
    "console.log(JSON.stringify(result));",
  ].join("\n");
  const proc = Bun.spawn({
    cmd: ["bun", "--eval", script],
    env: {
      ...process.env,
      HOME: home,
      DRAFT_API_BASE_URL: apiUrl,
      DRAFT_APP_URL: apiUrl,
      DRAFT_SUPABASE_URL: apiUrl,
      DRAFT_SUPABASE_PUBLISHABLE_KEY: "test-anon-key",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`cloud-client subprocess failed: ${stderr}`);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function authFile(): string {
  return join(home, ".draft", "personal", "cli-auth.json");
}

function readAuth(): AuthState {
  return JSON.parse(readFileSync(authFile(), "utf8")) as AuthState;
}

function providerRequests() {
  return backend.state.requests.filter((request) => PROVIDER_PATH.test(new URL(request.url).pathname));
}

function validConnection(overrides: Record<string, unknown> = {}) {
  return {
    provider: "slack",
    status: "active",
    display_name: "Slack",
    last_success_at: null,
    last_error_at: null,
    channel_ids: ["C1"],
    ...overrides,
  };
}

describe("hosted provider wrappers", () => {
  it("uses exact methods, paths, bodies, and one coherent bearer for all six wrappers", async () => {
    backend.state.connectionsListResponse = () => Response.json({
      connections: [validConnection({ internal_id: "must-not-pass-through" })],
    });
    backend.state.connectionsConnectResponse = () => Response.json({
      ok: true,
      webhookUrl: "https://api.test/webhooks/fireflies/key",
      webhookSecret: "one-time-secret",
      raw_provider_detail: "must-not-pass-through",
    });
    backend.state.slackChannelsResponse = () => Response.json({
      ok: true,
      channels: [{ id: "C1", name: "general", memberCount: 10, isMember: true }],
    });
    backend.state.slackMembershipResponse = () => Response.json({
      ok: false,
      channel_ids: ["C1"],
      joined: ["C1"],
      left: [],
      failed: [{ channel_id: "C2", operation: "join", code: "slack_channel_join_failed" }],
    });

    expect(await invoke("listConnections")).toEqual({
      ok: true,
      value: { connections: [validConnection()] },
    });
    expect(await invoke("connectIntegration", [{
      provider: "fireflies",
      api_token: "ff-secret",
      raw_extra: "must-not-send",
    }])).toEqual({
      ok: true,
      value: {
        ok: true,
        webhookUrl: "https://api.test/webhooks/fireflies/key",
        webhookSecret: "one-time-secret",
      },
    });
    expect(await invoke("disconnectIntegration", ["linear"])).toEqual({ ok: true, value: { ok: true } });
    expect(await invoke("createGithubInstallSession")).toMatchObject({
      ok: true,
      value: { code: "install-code" },
    });
    expect(await invoke("listSlackChannels")).toEqual({
      ok: true,
      value: { ok: true, channels: [{ id: "C1", name: "general", memberCount: 10, isMember: true }] },
    });
    expect(await invoke("setSlackChannels", [["C1", "C2"]])).toEqual({
      ok: true,
      value: {
        ok: false,
        channel_ids: ["C1"],
        joined: ["C1"],
        left: [],
        failed: [{ channel_id: "C2", operation: "join", code: "slack_channel_join_failed" }],
      },
    });

    expect(backend.state.requests.filter((request) => new URL(request.url).pathname === "/whoami")).toHaveLength(6);
    const requests = providerRequests();
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/workspaces/ws-1/connections"],
      ["POST", "/workspaces/ws-1/connections"],
      ["DELETE", "/workspaces/ws-1/connections/linear"],
      ["POST", "/workspaces/ws-1/github/install-sessions"],
      ["GET", "/workspaces/ws-1/connections/slack/channels"],
      ["PATCH", "/workspaces/ws-1/connections/slack"],
    ]);
    expect(requests.every((request) => request.headers.authorization === "Bearer seed-at")).toBe(true);
    expect(requests[1]!.headers["content-type"]).toBe("application/json");
    expect(requests[5]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(requests[1]!.body)).toEqual({ provider: "fireflies", api_token: "ff-secret" });
    expect(requests[2]!.body).toBe("");
    expect(JSON.parse(requests[5]!.body)).toEqual({ channel_ids: ["C1", "C2"] });
  });

  it("resolves a refreshed token once and uses it for both whoami and the provider request", async () => {
    seedCliAuth(home, { expires_at: Math.floor(Date.now() / 1000) - 1 });
    backend.state.refreshResponse = () => Response.json({
      access_token: "refreshed-at",
      refresh_token: "refreshed-rt",
      expires_in: 3600,
    });

    expect(await invoke("listConnections")).toEqual({ ok: true, value: { connections: [] } });

    const refreshes = backend.state.requests.filter((request) =>
      new URL(request.url).pathname === "/auth/v1/token"
    );
    expect(refreshes).toHaveLength(1);
    const protectedRequests = backend.state.requests.filter((request) => {
      const path = new URL(request.url).pathname;
      return path === "/whoami" || path === "/workspaces/ws-1/connections";
    });
    expect(protectedRequests).toHaveLength(2);
    expect(protectedRequests.every((request) => request.headers.authorization === "Bearer refreshed-at")).toBe(true);
  });

  it("uses one refreshed token and its whoami workspace for context fetches", async () => {
    seedCliAuth(home, {
      expires_at: Math.floor(Date.now() / 1000) - 1,
      workspace_id: "stale-workspace",
    });
    backend.state.refreshResponse = () => Response.json({
      access_token: "context-refreshed-at",
      refresh_token: "context-refreshed-rt",
      expires_in: 3600,
    });
    backend.state.whoamiResponse = () => defaultWhoami({ workspace_id: "current-workspace" });

    expect(await invoke("fetchWorkspaceContext")).toMatchObject({ ok: true });
    expect(backend.state.requests.filter((request) =>
      new URL(request.url).pathname === "/auth/v1/token"
    )).toHaveLength(1);
    const protectedRequests = backend.state.requests.filter((request) => {
      const path = new URL(request.url).pathname;
      return path === "/whoami" || path.endsWith("/context");
    });
    expect(protectedRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/whoami",
      "/workspaces/current-workspace/context",
    ]);
    expect(protectedRequests.every((request) =>
      request.headers.authorization === "Bearer context-refreshed-at"
    )).toBe(true);
  });

  it("persists a validated hydrated identity", async () => {
    backend.state.whoamiResponse = () => defaultWhoami({
      organization_id: "org-new",
      primary_team_id: "team-new",
      workspace_id: "workspace-new",
      onboarding_completed_at: "2026-08-20T12:00:00Z",
    });

    await invoke("listConnections");

    expect(readAuth()).toMatchObject({
      organization_id: "org-new",
      team_id: "team-new",
      workspace_id: "workspace-new",
      onboarding_completed_at: "2026-08-20T12:00:00Z",
      identity_resolved: true,
    });
  });

  it("does not overwrite a concurrently replaced auth session", async () => {
    backend.state.whoamiResponse = () => {
      seedCliAuth(home, {
        access_token: "replacement-at",
        refresh_token: "replacement-rt",
        organization_id: "replacement-org",
        team_id: "replacement-team",
        workspace_id: "replacement-workspace",
      });
      return defaultWhoami({
        organization_id: "old-org",
        primary_team_id: "old-team",
        workspace_id: "old-workspace",
      });
    };

    expect(await invoke("listConnections")).toEqual({ ok: true, value: { connections: [] } });
    expect(readAuth()).toMatchObject({
      access_token: "replacement-at",
      refresh_token: "replacement-rt",
      organization_id: "replacement-org",
      team_id: "replacement-team",
      workspace_id: "replacement-workspace",
    });
    const [whoami, provider] = backend.state.requests.filter((request) => {
      const path = new URL(request.url).pathname;
      return path === "/whoami" || path.endsWith("/connections");
    });
    expect(whoami?.headers.authorization).toBe("Bearer seed-at");
    expect(provider?.headers.authorization).toBe("Bearer seed-at");
    expect(new URL(provider!.url).pathname).toBe("/workspaces/old-workspace/connections");
  });

  it("does not clear a concurrently replaced session after a terminal refresh failure", async () => {
    seedCliAuth(home, { expires_at: Math.floor(Date.now() / 1000) - 1 });
    backend.state.refreshResponse = () => {
      seedCliAuth(home, {
        access_token: "replacement-at",
        refresh_token: "replacement-rt",
        workspace_id: "replacement-workspace",
      });
      return Response.json({ error: "invalid_grant" }, { status: 401 });
    };

    expect(await invoke("listConnections")).toEqual({ ok: false, code: "not_authenticated" });
    expect(readAuth()).toMatchObject({
      access_token: "replacement-at",
      refresh_token: "replacement-rt",
      workspace_id: "replacement-workspace",
    });
  });

  it("does not clear a concurrently replaced session after whoami returns 401", async () => {
    backend.state.whoamiResponse = () => {
      seedCliAuth(home, {
        access_token: "replacement-at",
        refresh_token: "replacement-rt",
        workspace_id: "replacement-workspace",
      });
      return new Response(null, { status: 401 });
    };

    expect(await invoke("listConnections")).toEqual({ ok: false, code: "not_authenticated" });
    expect(readAuth()).toMatchObject({
      access_token: "replacement-at",
      refresh_token: "replacement-rt",
      workspace_id: "replacement-workspace",
    });
  });

  it("returns no_workspace without making a provider request", async () => {
    backend.state.whoamiResponse = () => defaultWhoami({ workspace_id: null });

    expect(await invoke("listConnections")).toEqual({ ok: false, code: "no_workspace" });
    expect(providerRequests()).toHaveLength(0);
  });

  it.each([401, 403])("maps whoami %s to not_authenticated without throwing", async (status) => {
    backend.state.whoamiResponse = () => new Response(null, { status });
    expect(await invoke("listConnections")).toEqual({ ok: false, code: "not_authenticated" });
  });

  it("maps transport failure without throwing or leaking detail", async () => {
    const result = await invoke("listConnections", [], "http://127.0.0.1:1");
    expect(result).toEqual({ ok: false, code: "session_refresh_transient" });
  });

  it("preserves only allowlisted non-2xx codes and collapses raw backend detail", async () => {
    backend.state.slackChannelsResponse = () => Response.json({
      error: "slack_channel_list_failed",
      message: "raw-provider-canary",
    }, { status: 502 });
    expect(await invoke("listSlackChannels")).toEqual({ ok: false, code: "slack_channel_list_failed" });

    backend.state.slackMembershipResponse = () => Response.json({
      error: "connection_update_conflict",
      message: "raw-provider-canary",
    }, { status: 409 });
    expect(await invoke("setSlackChannels", [[]])).toEqual({ ok: false, code: "connection_update_conflict" });

    backend.state.connectionsListResponse = () => Response.json({
      error: "github_installation_conflict",
      message: "raw-provider-canary",
    }, { status: 409 });
    expect(await invoke("listConnections")).toEqual({ ok: false, code: "github_installation_conflict" });

    backend.state.connectionsListResponse = () => Response.json({
      error: "raw-error-canary",
      message: "raw-provider-canary",
    }, { status: 500 });
    const unknown = await invoke("listConnections");
    expect(unknown).toEqual({ ok: false, code: "request_failed" });
    expect(JSON.stringify(unknown)).not.toContain("canary");
  });

  it("maps malformed JSON and missing list fields to malformed_response", async () => {
    backend.state.connectionsListResponse = () => new Response("{not-json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    expect(await invoke("listConnections")).toEqual({ ok: false, code: "malformed_response" });

    backend.state.connectionsListResponse = () => Response.json({ connections: "wrong" });
    expect(await invoke("listConnections")).toEqual({ ok: false, code: "malformed_response" });
  });

  it("rejects missing fields, invalid status values, wrong arrays, and nested failure objects", async () => {
    backend.state.connectionsListResponse = () => Response.json({
      connections: [validConnection({ status: "credential_error" })],
    });
    expect(await invoke("listConnections")).toEqual({ ok: false, code: "malformed_response" });

    backend.state.connectionsListResponse = () => Response.json({
      connections: [{ provider: "github", status: "active" }],
    });
    expect(await invoke("listConnections")).toEqual({ ok: false, code: "malformed_response" });

    backend.state.slackChannelsResponse = () => Response.json({ ok: true, channels: {} });
    expect(await invoke("listSlackChannels")).toEqual({ ok: false, code: "malformed_response" });

    backend.state.slackMembershipResponse = () => Response.json({
      ok: false,
      channel_ids: [],
      joined: [],
      left: [],
      failed: [{ channel_id: "C1", operation: "join", code: { raw: "canary" } }],
    });
    const nested = await invoke("setSlackChannels", [[]]);
    expect(nested).toEqual({ ok: false, code: "malformed_response" });
    expect(JSON.stringify(nested)).not.toContain("canary");
  });

  it("accepts synthesized expired Claude Code status for later disconnected normalization", async () => {
    backend.state.connectionsListResponse = () => Response.json({
      connections: [validConnection({
        provider: "claude_code",
        status: "expired",
        display_name: null,
        channel_ids: undefined,
      })],
    });

    const result = await invoke("listConnections");
    expect(result).toEqual({
      ok: true,
      value: {
        connections: [{
          provider: "claude_code",
          status: "expired",
          display_name: null,
          last_success_at: null,
          last_error_at: null,
        }],
      },
    });
    const connections = (result.value as { connections: unknown[] }).connections;
    expect(normalizeHostedConnections(connections).find((item) => item.provider === "claude-code")?.status)
      .toBe("disconnected");
  });

  it("strictly validates every wrapper success envelope", async () => {
    backend.state.connectionsConnectResponse = () => Response.json({ ok: true, webhookUrl: "missing-secret" });
    expect(await invoke("connectIntegration", [{ provider: "fireflies", api_token: "secret" }])).toEqual({
      ok: false,
      code: "malformed_response",
    });

    backend.state.connectionsDisconnectResponse = () => Response.json({ ok: { nested: true } });
    expect(await invoke("disconnectIntegration", ["github"])).toEqual({ ok: false, code: "malformed_response" });

    backend.state.githubInstallSessionResponse = () => Response.json({
      code: "install-code",
      installUrl: "https://evil.example/install",
    });
    expect(await invoke("createGithubInstallSession")).toEqual({ ok: false, code: "malformed_response" });
  });
});

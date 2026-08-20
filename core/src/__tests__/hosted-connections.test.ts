import { describe, expect, it } from "bun:test";
import {
  normalizeHostedConnection,
  normalizeHostedConnections,
  type HostedConnectionProvider,
} from "../integrations/hosted-connections";

describe("normalizeHostedConnection", () => {
  it.each([
    [undefined, "disconnected", false],
    ["pending", "pending", false],
    ["active", "connected", true],
    ["degraded", "degraded", true],
    ["error", "error", false],
    ["revoked", "disconnected", false],
  ] as const)("maps %s to %s", (rawStatus, status, connected) => {
    const raw = rawStatus === undefined
      ? undefined
      : { provider: "github", status: rawStatus };
    expect(normalizeHostedConnection("github", raw)).toMatchObject({ status, connected });
  });

  it("keeps Fireflies pending until an authenticated webhook records evidence", () => {
    expect(normalizeHostedConnection("fireflies", {
      provider: "fireflies",
      status: "active",
      last_success_at: null,
    })).toMatchObject({ status: "pending", connected: false });

    expect(normalizeHostedConnection("fireflies", {
      provider: "fireflies",
      status: "active",
      last_success_at: "2026-08-20T12:00:00Z",
    })).toMatchObject({ status: "connected", connected: true });

    expect(normalizeHostedConnection("fireflies", {
      provider: "fireflies",
      status: "degraded",
      last_success_at: null,
    })).toMatchObject({ status: "degraded", connected: true });
  });

  it("keeps Slack membership and drops it from every other provider", () => {
    expect(normalizeHostedConnection("slack", {
      provider: "slack",
      status: "active",
      channel_ids: ["C1", 42, "C2"],
    }).channel_ids).toEqual(["C1", "C2"]);

    for (const provider of ["github", "linear", "fireflies", "claude-code"] satisfies HostedConnectionProvider[]) {
      expect(normalizeHostedConnection(provider, {
        provider,
        status: "active",
        channel_ids: ["secret-internal-channel"],
      })).not.toHaveProperty("channel_ids");
    }
  });
});

describe("normalizeHostedConnections", () => {
  it("returns a stable five-provider order and adds missing disconnected entries", () => {
    const connections = normalizeHostedConnections([
      { provider: "fireflies", status: "active", last_success_at: "2026-08-20T12:00:00Z" },
      { provider: "slack", status: "degraded", channel_ids: ["C1"] },
    ]);

    expect(connections.map(({ provider }) => provider)).toEqual([
      "github",
      "slack",
      "linear",
      "fireflies",
      "claude-code",
    ]);
    expect(connections.map(({ status }) => status)).toEqual([
      "disconnected",
      "degraded",
      "disconnected",
      "connected",
      "disconnected",
    ]);
  });

  it("maps the backend claude_code name and emits only the public summary shape", () => {
    const [github, slack, linear, fireflies, claudeCode] = normalizeHostedConnections([
      {
        provider: "claude_code",
        status: "active",
        display_name: "Claude Code",
        last_success_at: "2026-08-20T12:00:00Z",
        last_error_at: null,
        id: "internal-id",
        connection_key: "internal-key",
        credential_id: "internal-credential",
        config_json: { secret: true },
      } as Record<string, unknown>,
    ]);

    expect(claudeCode).toEqual({
      provider: "claude-code",
      status: "connected",
      connected: true,
      display_name: "Claude Code",
      last_success_at: "2026-08-20T12:00:00Z",
      last_error_at: null,
    });
    expect(Object.keys(claudeCode)).toEqual([
      "provider",
      "status",
      "connected",
      "display_name",
      "last_success_at",
      "last_error_at",
    ]);
    expect(github.status).toBe("disconnected");
    expect(slack.channel_ids).toEqual([]);
    expect(linear.status).toBe("disconnected");
    expect(fireflies.status).toBe("disconnected");
  });

  it("ignores unsupported providers and the session-capture toggle", () => {
    const connections = normalizeHostedConnections([
      { provider: "claude_session", status: "active" },
      { provider: "granola", status: "active" },
    ]);
    expect(connections.every(({ connected }) => !connected)).toBe(true);
  });

  it.each([
    undefined,
    null,
    { provider: "github", status: "active" },
    "not-an-array",
    [null],
    [42, "invalid", [], null],
  ])("returns the stable disconnected list for malformed input %#", (value) => {
    const connections = normalizeHostedConnections(value);

    expect(connections).toHaveLength(5);
    expect(connections.map(({ provider }) => provider)).toEqual([
      "github",
      "slack",
      "linear",
      "fireflies",
      "claude-code",
    ]);
    expect(connections.every(({ status, connected }) =>
      status === "disconnected" && connected === false
    )).toBe(true);
  });

  it("ignores malformed entries while normalizing valid entries", () => {
    const connections = normalizeHostedConnections([
      null,
      ["github"],
      { provider: "github", status: "active" },
      42,
    ]);

    expect(connections[0]).toMatchObject({
      provider: "github",
      status: "connected",
      connected: true,
    });
    expect(connections.slice(1).every(({ connected }) => !connected)).toBe(true);
  });
});

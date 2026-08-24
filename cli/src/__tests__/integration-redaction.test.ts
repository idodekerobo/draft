import { describe, expect, it } from "bun:test";
import { join } from "path";
import {
  INTEGRATION_ERROR_REGISTRY,
  createIntegrationOutput,
  redactIntegrationText,
  reportUnexpectedIntegrationFailure,
} from "../integrations/safe-output.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "integration-output-child.ts");

async function runFixture(input: Record<string, unknown>, debug = false) {
  const child = Bun.spawn({
    cmd: ["bun", FIXTURE],
    stdin: Buffer.from(JSON.stringify(input)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(debug ? { DEBUG: "raw-debug-canary" } : {}) },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("integration safe output", () => {
  it("defines the complete reviewed error registry and collapses unknown values", () => {
    expect(Object.keys(INTEGRATION_ERROR_REGISTRY).sort()).toEqual([
      "aborted",
      "auth_busy",
      "cancelled",
      "connection_update_conflict",
      "credential_input_required",
      "expired",
      "forbidden",
      "github_installation_conflict",
      "interrupted",
      "invalid_connect_usage",
      "invalid_credential_input",
      "invalid_usage",
      "linear_webhook_create_failed",
      "malformed_response",
      "no_workspace",
      "not_authenticated",
      "not_found",
      "not_supported",
      "poll_failed",
      "request_failed",
      "session_refresh_transient",
      "slack_channel_join_failed",
      "slack_channel_leave_failed",
      "slack_channel_list_failed",
      "timed_out",
      "whoami_failed",
      "workspace_changed",
    ]);
    const stdout: string[] = [];
    const output = createIntegrationOutput({ json: true, stdout: (value) => stdout.push(value) });
    expect(output.error({ code: "raw-provider-error", message: "raw-message", action: "raw-action" })).toBe(1);
    expect(JSON.parse(stdout.join(""))).toEqual({
      schema_version: 1,
      status: "error",
      code: "request_failed",
      message: "Could not complete the integration request. Retry shortly.",
    });
    expect(stdout.join("")).not.toContain("raw-");

    for (const inherited of [
      "toString",
      "constructor",
      Object.assign(Object.create({ code: "invalid_usage" }), { message: "raw-inherited" }),
      Object.assign(Object.create({ kind: "interrupted" }), { message: "raw-inherited" }),
    ]) {
      const lines: string[] = [];
      const inheritedOutput = createIntegrationOutput({ json: true, stdout: (value) => lines.push(value) });
      expect(inheritedOutput.error(inherited)).toBe(1);
      expect(JSON.parse(lines.join(""))).toMatchObject({ status: "error", code: "request_failed" });
    }
  });

  it("reconstructs exact public JSON and human terminal output", () => {
    const json: string[] = [];
    createIntegrationOutput({ json: true, stdout: (value) => json.push(value) }).event({
      status: "disconnected",
      provider: "slack",
    });
    expect(JSON.parse(json.join(""))).toEqual({
      schema_version: 1,
      status: "disconnected",
      provider: "slack",
    });
    expect(json.join("")).not.toContain("\x1b[");

    const stdout: string[] = [];
    const stderr: string[] = [];
    const human = createIntegrationOutput({
      json: false,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });
    human.event({ status: "connected", provider: "linear" });
    human.error({ code: "linear_webhook_create_failed", message: "raw-message" });
    expect(stdout.join("")).toBe("Linear: connected\n");
    expect(stderr.join("")).toBe("Linear webhook setup failed. Retry shortly.\n");

    const shortSecretOutput: string[] = [];
    const withShortSecret = createIntegrationOutput({ json: false, stdout: (value) => shortSecretOutput.push(value) });
    withShortSecret.registerSecret("a");
    expect(withShortSecret.event({ status: "connected", provider: "linear" })).toBe(0);
    expect(shortSecretOutput.join("")).toBe("Linear: connected\n");
  });

  it("redacts registered secrets and every planned defense-in-depth form", () => {
    const exact = "arbitrary-exact-canary";
    const hexSecret = "a".repeat(64);
    const sensitiveFields = [
      "api_token",
      "api_key",
      "bot_token",
      "app_token",
      "setup_token",
      "webhookSecret",
      "webhook_secret",
      "signing_secret",
      "access_token",
      "refresh_token",
      "token",
      "client_secret",
    ];
    for (const field of sensitiveFields) {
      const canary = `${field}-raw-canary`;
      const redacted = redactIntegrationText(JSON.stringify({ [field]: canary }));
      expect(redacted).not.toContain(canary);
      expect(JSON.parse(redacted)).toEqual({ [field]: "[REDACTED]" });
    }

    const redacted = redactIntegrationText([
      exact,
      "Authorization: Bearer bearer-raw-canary",
      "Authorization: Basic YmFzaWMtcmF3LWNhbmFyeQ==",
      "Authorization=Token token-scheme-raw-canary",
      "Bearer second-bearer-canary",
      "xoxb-slack-bot-canary",
      "xapp-slack-app-canary",
      "lin_api_linear-canary-value",
      hexSecret,
    ].join("\n"), [exact]);
    for (const canary of [exact, "bearer-raw-canary", "YmFzaWMtcmF3LWNhbmFyeQ==", "token-scheme-raw-canary", "second-bearer-canary", "xoxb-", "xapp-", "linear-canary", hexSecret]) {
      expect(redacted).not.toContain(canary);
    }
    expect(redacted).toContain("[REDACTED]");
  });

  it.each(["a", "quote\"slash\\line\nnext"])(
    "structurally redacts registered JSON secrets without changing the public schema: %j",
    async (secret) => {
      const result = await runFixture({ mode: "public_shape", json: true, secret });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({
        schema_version: 1,
        status: "ok",
        connections: [{ provider: "github", status: "connected" }],
      });
      expect(parsed.connections[0].display_name).toBe("[REDACTED]");
      expect(JSON.stringify(parsed.connections[0].display_name)).not.toContain(JSON.stringify(secret).slice(1, -1));
    },
  );

  it("redacts recognized credential forms inside dynamic JSON strings before serialization", () => {
    const stdout: string[] = [];
    const output = createIntegrationOutput({ json: true, stdout: (value) => stdout.push(value) });
    expect(output.event({
      status: "ok",
      connections: [{
        provider: "github",
        status: "connected",
        connected: true,
        display_name: "Authorization: Basic dynamic-json-canary",
        last_success_at: null,
        last_error_at: null,
      }],
    })).toBe(0);
    const serialized = stdout.join("");
    const parsed = JSON.parse(serialized);
    expect(parsed).toMatchObject({
      schema_version: 1,
      status: "ok",
      connections: [{
        provider: "github",
        status: "connected",
        display_name: "Authorization: [REDACTED]",
      }],
    });
    expect(serialized).not.toContain("dynamic-json-canary");
  });

  it("preserves only reviewed GitHub and Slack browser handoff URLs", async () => {
    const github = await runFixture({ mode: "browser_github", json: true });
    expect(JSON.parse(github.stdout)).toMatchObject({
      status: "browser_required",
      provider: "github",
      url: "https://github.com/apps/draft/installations/new?state=safe-state",
      expires_in_seconds: 300,
    });
    const slack = await runFixture({ mode: "browser_slack", json: true });
    expect(JSON.parse(slack.stdout)).toMatchObject({
      status: "browser_required",
      provider: "slack",
    });
    expect(JSON.parse(slack.stdout).url).toContain("manifest_json=");

    for (const mode of ["browser_unsafe", "browser_unsafe_github_query", "browser_unsafe_slack_manifest"]) {
      const secret = `${mode}-query-canary`;
      const unsafe = await runFixture({ mode, json: true, secret });
      expect(unsafe.exitCode).toBe(1);
      expect(JSON.parse(unsafe.stdout)).toMatchObject({ status: "error", code: "request_failed" });
      expect(`${unsafe.stdout}${unsafe.stderr}`).not.toContain(secret);
    }
  });

  it("preserves an approved token-shaped GitHub state in JSON and human handoffs", () => {
    const url = "https://github.com/apps/draft/installations/new?state=sk-abcdefgh";
    const json: string[] = [];
    const jsonOutput = createIntegrationOutput({ json: true, stdout: (value) => json.push(value) });
    expect(jsonOutput.event({ status: "browser_required", provider: "github", url })).toBe(0);
    expect(JSON.parse(json.join(""))).toMatchObject({ status: "browser_required", provider: "github", url });

    const stderr: string[] = [];
    const humanOutput = createIntegrationOutput({ json: false, stderr: (value) => stderr.push(value) });
    expect(humanOutput.event({ status: "browser_required", provider: "github", url })).toBe(0);
    expect(stderr.join("")).toBe(
      `Open this URL: ${url}\n`
      + "Install the Draft GitHub App and select the repositories to grant it access to.\n",
    );
  });

  it("never leaks canaries across success, typed/raw errors, throw, abort, or debug paths", async () => {
    const cases = [
      { mode: "public_shape", json: true, secret: "success-secret-canary" },
      { mode: "error", json: true, secret: "typed-secret-canary", error: { code: "linear_webhook_create_failed", message: "typed-secret-canary", action: "typed-secret-canary" } },
      { mode: "error", json: true, secret: "http-4xx-canary", error: { code: "request_failed", status: 400, body: "http-4xx-canary" } },
      { mode: "error", json: true, secret: "http-5xx-canary", error: { code: "request_failed", status: 500, body: "http-5xx-canary" } },
      { mode: "error", json: true, secret: "malformed-canary", error: { code: "malformed_response", raw: "malformed-canary" } },
      { mode: "error", json: true, secret: "unknown-canary", error: { code: "unknown-code", message: "unknown-canary" } },
      { mode: "throw", json: true, secret: "throw-canary" },
      { mode: "error", json: true, secret: "abort-canary", error: { kind: "aborted", reason: "abort-canary" } },
    ];
    for (const input of cases) {
      const result = await runFixture(input, true);
      if (input.mode === "public_shape") expect(result.exitCode).toBe(0);
      else expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("\x1b[");
      expect(result.stdout).not.toContain(input.secret);
      expect(result.stdout).not.toContain("raw-debug-canary");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    }
  });

  it("uses the static integration failure path for unexpected top-level errors", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(reportUnexpectedIntegrationFailure({
      json: true,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    })).toBe(1);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ status: "error", code: "request_failed" });
    expect(stderr).toEqual([]);
  });
});

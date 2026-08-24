import type {
  HostedConnectionProvider,
  HostedConnectionStatus,
  HostedConnectionSummary,
} from "draft-core/integrations/hosted-connections";
import type { HostedSlackChannel, SlackMembershipReconcileResult } from "../cloud-client.ts";
import { PROVIDER_LABELS } from "./types.ts";

export type IntegrationErrorCode =
  | "invalid_usage"
  | "credential_input_required"
  | "invalid_credential_input"
  | "interrupted"
  | "not_authenticated"
  | "auth_busy"
  | "session_refresh_transient"
  | "whoami_failed"
  | "no_workspace"
  | "request_failed"
  | "malformed_response"
  | "not_supported"
  | "not_found"
  | "forbidden"
  | "workspace_changed"
  | "expired"
  | "timed_out"
  | "aborted"
  | "poll_failed"
  | "github_installation_conflict"
  | "linear_webhook_create_failed"
  | "slack_channel_list_failed"
  | "slack_channel_join_failed"
  | "slack_channel_leave_failed"
  | "connection_update_conflict"
  | "cancelled";

interface ErrorDefinition {
  message: string;
  action?: string;
  exitCode: 1 | 2 | 130;
}

export const INTEGRATION_ERROR_REGISTRY: Record<IntegrationErrorCode, ErrorDefinition> = {
  invalid_usage: { message: "Invalid integrations command.", action: "draft --help", exitCode: 2 },
  credential_input_required: { message: "Credential input requires a controlling terminal or an explicit credential source.", exitCode: 2 },
  invalid_credential_input: { message: "Credential input is invalid for this provider.", exitCode: 2 },
  interrupted: { message: "Integration setup was interrupted.", exitCode: 130 },
  not_authenticated: { message: "Not signed in.", action: "draft auth login", exitCode: 1 },
  auth_busy: { message: "Authentication is busy. Retry shortly.", exitCode: 1 },
  session_refresh_transient: { message: "Could not refresh the current session. Retry shortly.", exitCode: 1 },
  whoami_failed: { message: "Could not verify the current workspace. Retry shortly.", exitCode: 1 },
  no_workspace: { message: "No workspace yet — finish onboarding in the Draft app.", exitCode: 1 },
  request_failed: { message: "Could not complete the integration request. Retry shortly.", exitCode: 1 },
  malformed_response: { message: "The Draft backend returned an invalid response. Retry shortly.", exitCode: 1 },
  not_supported: { message: "That integration operation is not supported.", exitCode: 1 },
  not_found: { message: "The requested integration resource was not found.", exitCode: 1 },
  forbidden: { message: "The integration request is not authorized for this workspace.", exitCode: 1 },
  workspace_changed: { message: "The active workspace changed during integration setup. Start again.", exitCode: 1 },
  expired: { message: "The integration setup session expired. Start again.", exitCode: 1 },
  timed_out: { message: "The integration setup timed out. Start again.", exitCode: 1 },
  aborted: { message: "Integration setup was interrupted.", exitCode: 130 },
  poll_failed: { message: "Could not verify integration setup. Retry shortly.", exitCode: 1 },
  github_installation_conflict: { message: "Another GitHub installation is already connected. Disconnect it first.", exitCode: 1 },
  linear_webhook_create_failed: { message: "Linear webhook setup failed. Retry shortly.", exitCode: 1 },
  slack_channel_list_failed: { message: "Could not list Slack channels. Retry shortly.", exitCode: 1 },
  slack_channel_join_failed: { message: "One or more Slack channels could not be joined.", exitCode: 1 },
  slack_channel_leave_failed: { message: "One or more Slack channels could not be left.", exitCode: 1 },
  connection_update_conflict: { message: "The integration changed concurrently. Retry shortly.", exitCode: 1 },
  cancelled: { message: "Cancelled.", exitCode: 1 },
};

export type IntegrationEvent =
  | { status: "ok"; connections: HostedConnectionSummary[] }
  | { status: "awaiting_credentials"; provider: HostedConnectionProvider }
  | { status: "opening_browser"; provider: HostedConnectionProvider }
  | { status: "browser_required"; provider: "github" | "slack"; url: string; expires_in_seconds?: number }
  | { status: "handoff_required"; provider: "fireflies"; url: string; opened: boolean }
  | { status: "awaiting_install"; provider: "github" | "slack" }
  | { status: "connected"; provider: HostedConnectionProvider; cleanup_pending?: true }
  | { status: "credential_stored"; provider: "claude-code" }
  | { status: "credentials_stored_webhook_pending"; provider: "fireflies" }
  | { status: "disconnected"; provider: HostedConnectionProvider }
  | { status: "not_supported"; provider: "claude-code"; code: "not_supported" }
  | { status: "channels"; provider: "slack"; channels: HostedSlackChannel[] }
  | { status: "channels_set"; provider: "slack"; result: SlackMembershipReconcileResult };

export interface IntegrationOutputOptions {
  json: boolean;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
}

export function redactIntegrationText(value: string, exactSecrets: Iterable<string> = []): string {
  let safe = value;
  for (const secret of exactSecrets) {
    if (secret.length > 0) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe
    .replace(/("(?:api_token|api_key|bot_token|app_token|setup_token|webhookSecret|webhook_secret|signing_secret|access_token|refresh_token|token|client_secret)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/\b(?:api_token|api_key|bot_token|app_token|setup_token|webhookSecret|webhook_secret|signing_secret|access_token|refresh_token|token|client_secret)\b\s*[:=]\s*\S+/gi, "credential=[REDACTED]")
    .replace(/\bAuthorization\s*[:=]\s*[^\r\n]+/gi, "Authorization: [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:xoxb|xapp)-[A-Za-z0-9-]+/gi, "[REDACTED]")
    .replace(/\b(?:sk|lin_api|setup|api)[-_][A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b[0-9a-f]{64}\b/gi, "[REDACTED]");
}

const STATIC_PAYLOAD_KEYS = new Set(["status", "provider", "code", "message", "action", "url"]);

function redactDynamicPayload(value: unknown, exactSecrets: Iterable<string>, key?: string): unknown {
  if (typeof value === "string") {
    if (key && STATIC_PAYLOAD_KEYS.has(key)) return value;
    return redactIntegrationText(value, exactSecrets);
  }
  if (Array.isArray(value)) return value.map((item) => redactDynamicPayload(item, exactSecrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactDynamicPayload(childValue, exactSecrets, childKey),
    ]),
  );
}

const PROVIDERS = new Set<HostedConnectionProvider>([
  "github",
  "slack",
  "linear",
  "fireflies",
  "claude-code",
]);
const STATUSES = new Set<HostedConnectionStatus>([
  "disconnected",
  "pending",
  "connected",
  "degraded",
  "error",
]);

function safeConnection(value: HostedConnectionSummary): HostedConnectionSummary | null {
  if (!value || typeof value !== "object" || !PROVIDERS.has(value.provider) || !STATUSES.has(value.status)) return null;
  const result: HostedConnectionSummary = {
    provider: value.provider,
    status: value.status,
    connected: value.status === "connected" || value.status === "degraded",
    display_name: typeof value.display_name === "string" ? value.display_name : null,
    last_success_at: typeof value.last_success_at === "string" ? value.last_success_at : null,
    last_error_at: typeof value.last_error_at === "string" ? value.last_error_at : null,
  };
  if (value.provider === "slack") {
    result.channel_ids = Array.isArray(value.channel_ids)
      ? value.channel_ids.filter((item): item is string => typeof item === "string")
      : [];
  }
  return result;
}

function errorCode(value: unknown): IntegrationErrorCode {
  const isKnown = (candidate: unknown): candidate is IntegrationErrorCode =>
    typeof candidate === "string" && Object.prototype.hasOwnProperty.call(INTEGRATION_ERROR_REGISTRY, candidate);
  if (isKnown(value)) {
    return value as IntegrationErrorCode;
  }
  if (value && typeof value === "object") {
    const candidate = value as { code?: unknown; kind?: unknown };
    if (Object.prototype.hasOwnProperty.call(candidate, "code") && isKnown(candidate.code)) {
      return candidate.code as IntegrationErrorCode;
    }
    if (Object.prototype.hasOwnProperty.call(candidate, "kind") && isKnown(candidate.kind)) {
      return candidate.kind as IntegrationErrorCode;
    }
  }
  return "request_failed";
}

function reviewedBrowserUrl(provider: "github" | "slack", value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
    if (provider === "github") {
      const match = url.pathname.match(/^\/apps\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/installations\/new$/);
      const states = url.searchParams.getAll("state");
      if (
        url.hostname !== "github.com" ||
        !match ||
        [...url.searchParams.keys()].some((key) => key !== "state") ||
        states.length !== 1
      ) return null;
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(states[0]!)) return null;
      return `https://github.com/apps/${match[1]}/installations/new?state=${encodeURIComponent(states[0]!)}`;
    }
    const keys = [...url.searchParams.keys()];
    const manifests = url.searchParams.getAll("manifest_json");
    if (
      url.hostname !== "api.slack.com" ||
      url.pathname !== "/apps" ||
      keys.length !== 2 ||
      new Set(keys).size !== 2 ||
      url.searchParams.get("new_app") !== "1" ||
      manifests.length !== 1
    ) return null;
    let manifest: unknown;
    try {
      manifest = JSON.parse(manifests[0]!);
    } catch {
      return null;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
    const serialized = JSON.stringify(manifest);
    if (redactIntegrationText(serialized) !== serialized) return null;
    return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(serialized)}`;
  } catch {
    return null;
  }
}

function reviewedHandoffUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.username || url.password || url.port || url.hash || url.search) return null;
    if (!url.pathname.startsWith("/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function eventPayload(event: IntegrationEvent): Record<string, unknown> | null {
  switch (event.status) {
    case "ok": {
      const connections = event.connections.map(safeConnection);
      return connections.every((connection) => connection !== null)
        ? { status: "ok", connections }
        : null;
    }
    case "browser_required": {
      const url = reviewedBrowserUrl(event.provider, event.url);
      if (!url) return null;
      const payload: Record<string, unknown> = {
        status: "browser_required",
        provider: event.provider,
        url,
      };
      if (typeof event.expires_in_seconds === "number" && Number.isInteger(event.expires_in_seconds) && event.expires_in_seconds > 0) {
        payload.expires_in_seconds = event.expires_in_seconds;
      }
      return payload;
    }
    case "handoff_required": {
      const url = reviewedHandoffUrl(event.url);
      if (!url) return null;
      return { status: "handoff_required", provider: "fireflies", url, opened: event.opened };
    }
    case "not_supported":
      return { status: "not_supported", provider: "claude-code", code: "not_supported" };
    case "channels":
      return {
        status: "channels",
        provider: "slack",
        channels: event.channels.map((channel) => ({ ...channel })),
      };
    case "channels_set":
      return {
        status: "channels_set",
        provider: "slack",
        ok: event.result.ok,
        channel_ids: [...event.result.channel_ids],
        joined: [...event.result.joined],
        left: [...event.result.left],
        failed: event.result.failed.map((failure) => ({ ...failure })),
      };
    case "connected": {
      if (!PROVIDERS.has(event.provider)) return null;
      const payload: Record<string, unknown> = { status: event.status, provider: event.provider };
      if (event.cleanup_pending) payload.cleanup_pending = true;
      return payload;
    }
    case "awaiting_credentials":
    case "opening_browser":
    case "awaiting_install":
    case "credential_stored":
    case "credentials_stored_webhook_pending":
    case "disconnected":
      if (!PROVIDERS.has(event.provider)) return null;
      return { status: event.status, provider: event.provider };
  }
}

export class IntegrationOutput {
  private readonly secrets = new Set<string>();
  private readonly writeStdout: (value: string) => void;
  private readonly writeStderr: (value: string) => void;

  constructor(private readonly options: IntegrationOutputOptions) {
    this.writeStdout = options.stdout ?? ((value) => process.stdout.write(value));
    this.writeStderr = options.stderr ?? ((value) => process.stderr.write(value));
  }

  registerSecret(secret: string): void {
    if (secret.length > 0) this.secrets.add(secret);
  }

  registerSecrets(secrets: Iterable<string>): void {
    for (const secret of secrets) this.registerSecret(secret);
  }

  event(event: IntegrationEvent): 0 | 1 {
    const payload = eventPayload(event);
    if (!payload) {
      return this.error("request_failed") as 1;
    }
    if (this.options.json) {
      this.json({ schema_version: 1, ...payload });
      if (event.status === "connected" && event.cleanup_pending) this.emitCleanupPendingWarning(event.provider);
      if (event.status === "channels_set") this.emitChannelFailureWarnings(event.result.failed);
      return 0;
    }

    if (event.status === "ok") {
      for (const connection of payload.connections as HostedConnectionSummary[]) {
        this.stdout(`${PROVIDER_LABELS[connection.provider]}: ${connection.status}\n`);
      }
      return 0;
    }
    if (event.status === "browser_required") {
      this.writeStderr(`Open this URL: ${String(payload.url)}\n`);
      if (event.provider === "github") {
        this.writeStderr("Install the Draft GitHub App and select the repositories to grant it access to.\n");
      }
      return 0;
    }
    if (event.status === "handoff_required") {
      this.writeStderr(
        event.opened
          ? "Opening a local page with your Fireflies webhook details.\n"
          : `Open this page to finish Fireflies setup: ${String(payload.url)}\n`,
      );
      this.writeStderr(
        "In Fireflies, add the webhook at https://app.fireflies.ai/integrations/api/webhook "
        + "and enable the Meeting Transcribed and Meeting Summarized events.\n",
      );
      return 0;
    }
    if (event.status === "awaiting_credentials") {
      this.stderr(`Waiting for ${PROVIDER_LABELS[event.provider]} credentials.\n`);
      return 0;
    }
    if (event.status === "opening_browser" || event.status === "awaiting_install") {
      this.stderr(`${event.status === "opening_browser" ? "Opening browser" : "Waiting for installation"}.\n`);
      return 0;
    }
    if (event.status === "credential_stored") {
      this.stdout("Claude Code: credential stored\n");
      return 0;
    }
    if (event.status === "credentials_stored_webhook_pending") {
      this.stdout("Fireflies: credentials stored; webhook setup pending\n");
      return 0;
    }
    if (event.status === "connected") {
      this.stdout(`${PROVIDER_LABELS[event.provider]}: connected\n`);
      if (event.cleanup_pending) this.emitCleanupPendingWarning(event.provider);
      return 0;
    }
    if (event.status === "channels") {
      for (const channel of event.channels) {
        this.stdout(`#${channel.name} (${channel.id}) — ${channel.memberCount} members${channel.isMember ? " [joined]" : ""}\n`);
      }
      return 0;
    }
    if (event.status === "channels_set") {
      this.stdout(`Slack channels: ${event.result.channel_ids.length} selected (${event.result.joined.length} joined, ${event.result.left.length} left)\n`);
      this.emitChannelFailureWarnings(event.result.failed);
      return 0;
    }
    this.stdout(`${PROVIDER_LABELS[event.provider]}: ${event.status === "not_supported" ? "not supported" : event.status}\n`);
    return 0;
  }

  private emitCleanupPendingWarning(provider: HostedConnectionProvider): void {
    this.stderr(`Warning: a previous ${PROVIDER_LABELS[provider]} webhook could not be removed automatically; cleanup will retry.\n`);
  }

  private emitChannelFailureWarnings(failed: SlackMembershipReconcileResult["failed"]): void {
    for (const failure of failed) {
      this.stderr(`Warning: could not ${failure.operation} channel ${failure.channel_id}.\n`);
    }
  }

  error(error: unknown): 1 | 2 | 130 {
    const code = errorCode(error);
    const definition = INTEGRATION_ERROR_REGISTRY[code];
    if (this.options.json) {
      const payload = definition.action
        ? { schema_version: 1, status: "error", code, message: definition.message, action: definition.action }
        : { schema_version: 1, status: "error", code, message: definition.message };
      this.json(payload);
    } else {
      this.stderr(`${definition.message}${definition.action ? ` Run \`${definition.action}\`.` : ""}\n`);
    }
    return definition.exitCode;
  }

  private redact(value: string): string {
    return redactIntegrationText(value);
  }

  private json(payload: Record<string, unknown>): void {
    const structurallyRedacted = redactDynamicPayload(payload, this.secrets);
    this.writeStdout(`${JSON.stringify(structurallyRedacted)}\n`);
  }

  private stdout(value: string): void {
    this.writeStdout(this.redact(value));
  }

  private stderr(value: string): void {
    this.writeStderr(this.redact(value));
  }
}

export function createIntegrationOutput(options: IntegrationOutputOptions): IntegrationOutput {
  return new IntegrationOutput(options);
}

export function reportUnexpectedIntegrationFailure(options: IntegrationOutputOptions): 1 {
  return new IntegrationOutput(options).error("request_failed") as 1;
}

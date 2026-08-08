import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProviderCredential } from "../../credentials/resolve-provider-credential";
import { CredentialError } from "../../credentials/crypto";
import { handleSlackMessageEvent } from "./normalize";

export interface SlackListenerConnection {
  id: string;
  workspace_id: string;
  organization_id: string;
}

export interface SlackListenerHandle {
  stop(): void;
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 300_000;

const TERMINAL_SLACK_AUTH_ERRORS = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "account_inactive",
]);

export class SlackSocketOpenError extends Error {
  constructor(public readonly slackCode: string) {
    super(`apps.connections.open failed: ${slackCode}`);
    this.name = "SlackSocketOpenError";
  }
}

export type SlackListenerFailure = {
  retryable: boolean;
  connectionStatus?: "revoked" | "error";
};

/** Classifies failures without timers or network access so retry policy stays explicit. */
export function classifySlackListenerFailure(error: unknown): SlackListenerFailure {
  if (error instanceof SlackSocketOpenError) {
    return TERMINAL_SLACK_AUTH_ERRORS.has(error.slackCode)
      ? { retryable: false, connectionStatus: "revoked" }
      : { retryable: true };
  }
  if (error instanceof CredentialError) {
    return ["missing", "revoked", "expired", "decrypt_failed"].includes(error.reason)
      ? {
          retryable: false,
          connectionStatus: error.reason === "revoked" || error.reason === "expired" ? "revoked" : "error",
        }
      : { retryable: true };
  }
  return { retryable: true };
}

/** Pure backoff step, extracted so the doubling/cap logic is unit-testable
 * without standing up a WebSocket. */
export function nextReconnectDelay(
  currentDelayMs: number,
  maxDelayMs: number = MAX_RECONNECT_DELAY_MS,
): number {
  return Math.min(currentDelayMs * 2, maxDelayMs);
}

function log(
  level: "info" | "warn" | "error",
  connectionId: string,
  msg: string,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component: "slack-socket-listener",
    connection_id: connectionId,
    msg,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

async function getSocketModeUrl(appToken: string): Promise<string> {
  const response = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  const data = (await response.json()) as { ok: boolean; url: string; error?: string };
  if (!data.ok) throw new SlackSocketOpenError(data.error ?? "unknown_error");
  return data.url;
}

export function connectSlackSocketListener(
  connection: SlackListenerConnection,
  client?: SupabaseClient,
): SlackListenerHandle {
  let stopped = false;
  let ws: WebSocket | null = null;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  async function stopForTerminalFailure(err: unknown, status: "revoked" | "error"): Promise<void> {
    stopped = true;
    const db = client ?? (await import("../../db/client")).serviceClient;
    const { error } = await db
      .from("source_connections")
      .update({ status, last_error_at: new Date().toISOString() })
      .eq("id", connection.id)
      .eq("workspace_id", connection.workspace_id);
    if (error) log("error", connection.id, `failed to persist terminal listener status: ${error}`);
    log("error", connection.id, `terminal listener failure: ${err} — stopped; not retrying`);
  }

  async function handleConnectFailure(err: unknown, context: string): Promise<void> {
    const classification = classifySlackListenerFailure(err);
    if (!classification.retryable && classification.connectionStatus) {
      await stopForTerminalFailure(err, classification.connectionStatus);
      return;
    }
    log("error", connection.id, `${context}: ${err} — retrying in ${reconnectDelay}ms`);
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    reconnectTimer = setTimeout(() => {
      reconnectDelay = nextReconnectDelay(reconnectDelay);
      connect().catch((err) => log("error", connection.id, `reconnect error: ${err}`));
    }, reconnectDelay);
  }

  const connect = async (): Promise<void> => {
    if (stopped) return;

    let botToken: string;
    let appToken: string;
    try {
      const credential = await resolveProviderCredential(connection.workspace_id, "slack", client);
      botToken = credential.bot_token;
      appToken = credential.app_token;
    } catch (err) {
      await handleConnectFailure(err, "credential resolution failed");
      return;
    }

    try {
      const url = await getSocketModeUrl(appToken);
      ws = new WebSocket(url);

      ws.onopen = () => {
        log("info", connection.id, "Socket Mode connected");
        reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      };

      ws.onmessage = (event: MessageEvent) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        // An unacked envelope gets redelivered by Slack, so ack immediately.
        if (msg.envelope_id) {
          ws?.send(JSON.stringify({ envelope_id: msg.envelope_id }));
        }

        if (msg.type === "hello") {
          log("info", connection.id, "received hello — connection established");
          return;
        }

        if (msg.type === "disconnect") {
          const reason = (msg.reason as string | undefined) ?? "unknown";
          log("warn", connection.id, `received disconnect (reason=${reason}) — reconnecting`);
          ws?.close();
          return;
        }

        if (msg.type === "events_api") {
          const payload = msg.payload as Record<string, unknown> | undefined;
          const slackEvent = payload?.event as Record<string, unknown> | undefined;
          if (slackEvent?.type === "message") {
            const channelId = (slackEvent.channel as string | undefined) ?? "";
            handleSlackMessageEvent(
              slackEvent,
              {
                connectionId: connection.id,
                workspaceId: connection.workspace_id,
                organizationId: connection.organization_id,
                channelId,
                channelName: null,
                botToken,
              },
              client,
            ).catch((err) => log("error", connection.id, `handleSlackMessageEvent error: ${err}`));
          }
        }
      };

      ws.onerror = () => {
        log("error", connection.id, "WebSocket error");
      };

      ws.onclose = () => {
        if (stopped) return;
        log("warn", connection.id, `WebSocket closed — reconnecting in ${reconnectDelay}ms`);
        scheduleReconnect();
      };
    } catch (err) {
      await handleConnectFailure(err, "connection error");
    }
  };

  connect().catch((err) => log("error", connection.id, `initial connect error: ${err}`));

  return {
    stop(): void {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      ws?.close();
    },
  };
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProviderCredential } from "../../credentials/resolve-provider-credential";
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
  if (!data.ok) throw new Error(`apps.connections.open failed: ${data.error}`);
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
      log("error", connection.id, `credential resolution failed: ${err} — retrying in ${reconnectDelay}ms`);
      scheduleReconnect();
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
      log("error", connection.id, `connection error: ${err} — retrying in ${reconnectDelay}ms`);
      scheduleReconnect();
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

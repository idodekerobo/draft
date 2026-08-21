import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  connectIntegration,
  listConnections,
  type ConnectIntegrationResult,
  type FetchResult,
  type HostedConnectionTransport,
} from "../../cloud-client.ts";
import {
  CredentialInputError,
  credentialReader,
  type CredentialReader,
} from "../credentials.ts";
import { browserLauncher, type BrowserLauncher } from "../browser.ts";
import { ttyConfirm, ttyWaitForAck } from "../tty-prompt.ts";
import type { IntegrationOutput } from "../safe-output.ts";

const ACK_TIMEOUT_MS = 10 * 60 * 1000;

export interface FirefliesConnectOptions {
  noOpen: boolean;
}

export interface FirefliesConnectDeps {
  reader: CredentialReader;
  launcher: BrowserLauncher;
  listConnections(): Promise<FetchResult<{ connections: HostedConnectionTransport[] }>>;
  connect(body: { provider: "fireflies"; api_token: string }): Promise<FetchResult<ConnectIntegrationResult>>;
  confirm: typeof ttyConfirm;
  waitForAck: typeof ttyWaitForAck;
  ackTimeoutMs: number;
  onSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  offSignal(signal: "SIGINT" | "SIGTERM", handler: () => void): void;
  mkTempDir(): string;
  writeFile(path: string, content: string): void;
  removeDir(path: string): void;
}

const defaultDeps: FirefliesConnectDeps = {
  reader: credentialReader,
  launcher: browserLauncher,
  listConnections,
  connect: connectIntegration,
  confirm: ttyConfirm,
  waitForAck: ttyWaitForAck,
  ackTimeoutMs: ACK_TIMEOUT_MS,
  onSignal: (signal, handler) => { process.on(signal, handler); },
  offSignal: (signal, handler) => { process.off(signal, handler); },
  mkTempDir: () => mkdtempSync(join(tmpdir(), "draft-fireflies-")),
  writeFile: (path, content) => writeFileSync(path, content, { mode: 0o600 }),
  removeDir: (path) => { try { rmSync(path, { recursive: true, force: true }); } catch {} },
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function handoffHtml(webhookUrl: string, webhookSecret: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Fireflies webhook setup</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px; margin: 40px auto; line-height: 1.5; color: #1a1a1a;">
<h1>Fireflies webhook setup</h1>
<p>In Fireflies, add a webhook with these values:</p>
<p><strong>Webhook URL</strong><br><code>${escapeHtml(webhookUrl)}</code></p>
<p><strong>Webhook secret</strong><br><code>${escapeHtml(webhookSecret)}</code></p>
<p>Return to your terminal and press Enter once you're done.</p>
</body>
</html>
`;
}

function isReconnecting(connections: HostedConnectionTransport[]): boolean {
  return connections.some((connection) =>
    connection.provider === "fireflies" && connection.status !== null && connection.status !== "revoked"
  );
}

export async function runFirefliesConnect(
  options: FirefliesConnectOptions,
  output: IntegrationOutput,
  deps: FirefliesConnectDeps = defaultDeps,
): Promise<number> {
  if (!(await deps.reader.preflightTty())) return output.error("credential_input_required");

  const controller = new AbortController();
  const onSignal = () => controller.abort();
  deps.onSignal("SIGINT", onSignal);
  deps.onSignal("SIGTERM", onSignal);

  try {
    const existing = await deps.listConnections();
    if (!existing.ok) return output.error(existing.code);

    if (isReconnecting(existing.value.connections)) {
      const confirmed = await deps.confirm(
        "Reconnecting Fireflies rotates the webhook secret; the old one will stop working. Continue? [y/N] ",
        controller.signal,
      );
      if (confirmed === "interrupted") return output.error("aborted");
      if (confirmed !== "yes") return output.error("cancelled");
    }
    if (controller.signal.aborted) return output.error("aborted");

    let credentials: { api_token: string };
    try {
      credentials = await deps.reader.read("fireflies", { kind: "tty" });
    } catch (error) {
      return output.error(error instanceof CredentialInputError ? error.code : "invalid_credential_input");
    }
    output.registerSecret(credentials.api_token);
    if (controller.signal.aborted) return output.error("aborted");

    const result = await deps.connect({ provider: "fireflies", api_token: credentials.api_token });
    if (!result.ok) return output.error(result.code);
    if (!("webhookUrl" in result.value) || !("webhookSecret" in result.value)) {
      return output.error("malformed_response");
    }

    const dir = deps.mkTempDir();
    try {
      const path = join(dir, "index.html");
      deps.writeFile(path, handoffHtml(result.value.webhookUrl, result.value.webhookSecret));
      const fileUrl = `file://${path}`;

      let opened = false;
      if (!options.noOpen) {
        try {
          opened = (await deps.launcher.launchBrowser(fileUrl)).opened;
        } catch {
          opened = false;
        }
      }
      const handoff = output.event({ status: "handoff_required", provider: "fireflies", url: fileUrl, opened });
      if (handoff !== 0) return handoff;

      await deps.waitForAck(
        "Press Enter once you've added the webhook in Fireflies (this continues automatically after 10 minutes): ",
        deps.ackTimeoutMs,
        controller.signal,
      );
    } finally {
      deps.removeDir(dir);
    }

    return output.event({ status: "credentials_stored_webhook_pending", provider: "fireflies" });
  } finally {
    deps.offSignal("SIGINT", onSignal);
    deps.offSignal("SIGTERM", onSignal);
  }
}

import { ApprovalBroker } from "../approvals";
import type { ControlInput } from "../controls";
import type { ForwardedLine } from "../forwarder";
import { findRunnerBin } from "../find-bin";
import { LaunchError, type DriverHost, type HarnessDriver, type HarnessLauncher, type HarnessRegistration, type HostInput } from "../harness-driver";
import type { PendingInput } from "../input-delivery";
import { openCommandInTerminal } from "../open-in-terminal";
import { shellQuote } from "../launch";
import { COMMAND_APPROVAL, FILE_CHANGE_APPROVAL, approvalDecision, approvalPayload } from "./approvals";
import { startAppServer, type AppServer } from "./app-server-process";
import { CODEX_MISSING_MESSAGE, CODEX_SIGNED_OUT_MESSAGE, readCodexAuth, readCodexVersion } from "./codex-check";
import { RpcClient, type RpcHandlers } from "./rpc-client";

const THREAD_FILE = "thread";
const MAX_LINE_CHARS = 1_000_000;
export const TERMINAL_TOKEN_ENV = "DRAFT_CODEX_TOKEN";

interface ThreadStartResult {
  thread: { id: string };
}

const textInput = (input: PendingInput) => [{ type: "text", text: input.delivered_text, text_elements: [] }];

interface TurnStartResult {
  turn: { id: string };
}

type Sink = {
  notification(method: string, params: unknown): void;
  request(id: number | string, method: string, params: unknown): void;
};

/** One app server with its connection and thread. It lives as long as the session runs on this computer. */
class CodexConnection {
  sink: Sink | null = null;
  busy = false;
  turnId: string | null = null;
  hasTurned = false;
  rpc!: RpcClient;

  constructor(readonly server: AppServer, readonly threadId: string, readonly folderPath: string, readonly bin: string) {}

  isAlive(): boolean {
    return this.rpc.isOpen();
  }

  stop(): void {
    this.rpc.close();
    this.server.stop();
  }
}

const live = new Map<string, CodexConnection>();

process.on("exit", () => {
  for (const connection of live.values()) connection.server.stop();
});

async function connect(server: AppServer, handlers: RpcHandlers): Promise<RpcClient> {
  const rpc = await RpcClient.connect(server.url, server.token, handlers);
  await rpc.request("initialize", { clientInfo: { name: "draft", title: "Draft", version: "0" }, capabilities: null });
  rpc.notify("initialized");
  return rpc;
}

/** Codex through `codex app-server`: lines are completed items, approvals are server requests. */
export class CodexDriver implements HarnessDriver {
  private readonly broker: ApprovalBroker;
  private readonly requests = new Map<number | string, AbortController>();
  private readonly queue: ForwardedLine[] = [];
  private offset = 0;
  private flushing = false;
  private recovered = false;
  private reported = new Map<string, string>();
  private readonly steerFailed = new Set<string>();
  private halted = false;

  constructor(private readonly host: DriverHost) {
    this.broker = new ApprovalBroker({
      postEvents: (events) => host.postHostEvents(events),
      paneBlocked: async () => false,
      newId: () => `r${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      onOpen: (id) => host.persist({ openRequests: [...(host.state().openRequests ?? []), id] }),
      onClose: (id) => host.persist({ openRequests: (host.state().openRequests ?? []).filter((open) => open !== id) }),
    });
  }

  private get connection(): CodexConnection | null {
    return live.get(this.host.state().sessionId) ?? null;
  }

  start(): void {
    for (const requestId of this.host.state().openRequests ?? []) {
      void this.broker.closeOnServer(requestId, { requestId, reason: "hook_gone" });
    }
    const connection = this.connection;
    if (!connection) return;
    connection.sink = {
      notification: (method, params) => this.onNotification(connection, method, params),
      request: (id, method, params) => void this.onRequest(connection, id, method, params),
    };
  }

  private onNotification(connection: CodexConnection, method: string, params: unknown): void {
    const p = (params ?? {}) as { threadId?: string; turn?: { id?: string }; requestId?: number | string };
    if (method === "serverRequest/resolved") {
      if (p.requestId !== undefined) this.requests.get(p.requestId)?.abort();
      return;
    }
    if (p.threadId !== connection.threadId) return;
    if (method === "turn/started") {
      connection.busy = true;
      connection.turnId = p.turn?.id ?? connection.turnId;
      connection.hasTurned = true;
    } else if (method === "turn/completed") {
      connection.busy = false;
      connection.turnId = null;
    }
    if (method === "item/completed" || method === "turn/completed") this.enqueue({ method, params });
  }

  private async onRequest(connection: CodexConnection, id: number | string, method: string, params: unknown): Promise<void> {
    const payload = approvalPayload(method, params);
    if (!payload) {
      connection.rpc.respondError(id, -32601, "Draft does not handle this request.");
      return;
    }
    const controller = new AbortController();
    this.requests.set(id, controller);
    const answer = await this.broker.hold(payload, controller.signal);
    this.requests.delete(id);
    // Answered in another client, such as the terminal. Codex already moved on.
    if (controller.signal.aborted || !connection.isAlive()) return;
    connection.rpc.respond(id, { decision: approvalDecision(answer) });
  }

  private enqueue(note: { method: string; params: unknown }): void {
    const raw = JSON.stringify(note);
    this.queue.push(raw.length > MAX_LINE_CHARS ? { file: THREAD_FILE, offset: this.offset++, oversizeBytes: raw.length } : { file: THREAD_FILE, offset: this.offset++, raw });
    void this.drain();
  }

  /** Posts queued lines in order. A line that did not reach the server stays queued for the next pass. */
  private async drain(): Promise<boolean> {
    if (this.flushing) return this.queue.length === 0;
    this.flushing = true;
    try {
      while (this.queue.length > 0 && !this.halted) {
        const batch = this.queue.slice(0, 200);
        try {
          await this.host.postLines(batch);
        } catch (error) {
          if (this.host.isFatal(error)) this.host.onFatal(error);
          else console.error("[live-session] posting codex lines failed", error);
          return false;
        }
        this.queue.splice(0, batch.length);
      }
    } finally {
      this.flushing = false;
    }
    return this.queue.length === 0;
  }

  halt(): void {
    this.halted = true;
  }

  dispose(): void {
    this.halt();
    for (const controller of this.requests.values()) controller.abort();
    const connection = this.connection;
    if (connection) {
      connection.sink = null;
      connection.stop();
      live.delete(this.host.state().sessionId);
    }
  }

  async isAlive(): Promise<boolean> {
    return this.connection?.isAlive() ?? false;
  }

  flush(): Promise<boolean> {
    return this.drain();
  }

  refresh(): Promise<boolean> {
    return this.drain();
  }

  async serve(inputs: HostInput[]): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    await this.drain();
    const controls = inputs.filter((i): i is ControlInput => i.kind !== "message");
    const messages = inputs.filter((i): i is PendingInput => i.kind === "message");
    try {
      if (!this.recovered) await this.recover(controls, messages);
      await this.runControls(connection, controls);
      await this.deliver(connection, messages);
    } catch (error) {
      this.host.reportError("codex input", error);
    }
  }

  /** An input left `delivering` by an earlier run has no known outcome. */
  private async recover(controls: ControlInput[], messages: PendingInput[]): Promise<void> {
    for (const input of controls.filter((i) => i.state === "delivering")) await this.host.setInputState(input.id, ["delivering"], "failed", "host_restarted");
    for (const input of messages.filter((i) => i.state === "delivering")) await this.host.setInputState(input.id, ["delivering"], "uncertain", "host_restarted");
    this.recovered = true;
  }

  private async runControls(connection: CodexConnection, controls: ControlInput[]): Promise<void> {
    for (const input of controls.filter((i) => i.state === "queued")) {
      if (!(await this.host.setInputState(input.id, ["queued"], "delivering"))) continue;
      try {
        if (input.kind === "permission_decision") {
          const { requestId, decision } = input.payload;
          const decided =
            typeof requestId === "string" &&
            (decision === "allow" || decision === "deny") &&
            this.broker.decide(requestId, decision, { userId: input.author_user_id, name: input.author_name });
          await this.host.setInputState(input.id, ["delivering"], decided ? "consumed" : "failed", decided ? undefined : "request_not_open");
        } else {
          if (connection.busy && connection.turnId) await connection.rpc.request("turn/interrupt", { threadId: connection.threadId, turnId: connection.turnId });
          await this.host.setInputState(input.id, ["delivering"], "consumed");
        }
      } catch (error) {
        console.error("[live-session] codex control action failed", input.id, error);
        await this.host.setInputState(input.id, ["delivering"], "failed", "pane_unavailable").catch(() => {});
      }
    }
  }

  private async deliver(connection: CodexConnection, messages: PendingInput[]): Promise<void> {
    const queued = messages.filter((i) => i.state === "queued");
    if (queued.length === 0) return;
    if (connection.busy) {
      for (const input of queued) {
        if (this.reported.get(input.id) === "composer_busy") continue;
        this.reported.set(input.id, "composer_busy");
        await this.host.setInputState(input.id, ["queued"], "queued", "composer_busy");
      }
      const steered = queued.find((i) => i.payload?.steer && !this.steerFailed.has(i.id));
      if (steered && connection.turnId) await this.steer(connection, steered);
      return;
    }
    const next = queued[0]!;
    if (!(await this.host.setInputState(next.id, ["queued"], "delivering"))) return;
    try {
      const started = await connection.rpc.request<TurnStartResult>("turn/start", { threadId: connection.threadId, input: textInput(next) });
      connection.busy = true;
      connection.turnId = started.turn.id;
      connection.hasTurned = true;
    } catch (error) {
      console.error("[live-session] codex turn/start failed", next.id, error);
      await this.host.setInputState(next.id, ["delivering"], "failed", "not_submitted").catch(() => {});
    }
  }

  /** Adds a message to the turn that runs. If that turn ended meanwhile, the message goes back to waiting for the next one. */
  private async steer(connection: CodexConnection, input: PendingInput): Promise<void> {
    if (!(await this.host.setInputState(input.id, ["queued"], "delivering"))) return;
    try {
      await connection.rpc.request("turn/steer", { threadId: connection.threadId, expectedTurnId: connection.turnId, input: textInput(input) });
    } catch (error) {
      console.error("[live-session] codex turn/steer failed", input.id, error);
      this.steerFailed.add(input.id);
      this.reported.delete(input.id);
      await this.host.setInputState(input.id, ["delivering"], "queued", "composer_busy").catch(() => {});
    }
  }

  rotationTarget(): string | null {
    return null;
  }

  clearRotation(): void {}

  async finalize(): Promise<boolean> {
    return this.drain();
  }

  /** Stops the running turn, then the app server. Codex keeps the thread on disk. */
  async stop(): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    if (connection.busy && connection.turnId) {
      await connection.rpc.request("turn/interrupt", { threadId: connection.threadId, turnId: connection.turnId }).catch(() => {});
    }
    connection.stop();
  }

  async openInTerminal(): Promise<{ ok: true } | { ok: false; error: string }> {
    const connection = this.connection;
    if (!connection || !connection.isAlive()) return { ok: false, error: "The session has already ended." };
    // A thread exists on disk only after its first turn, and the terminal can resume only a thread on disk.
    if (!connection.hasTurned) return { ok: false, error: "Send a first message, then open the terminal." };
    const command = [
      `cd ${shellQuote(connection.folderPath)}`,
      `export ${TERMINAL_TOKEN_ENV}=${shellQuote(connection.server.token)}`,
      `exec ${shellQuote(connection.bin)} resume --remote ${shellQuote(connection.server.url)} --remote-auth-token-env ${TERMINAL_TOKEN_ENV} ${shellQuote(connection.threadId)}`,
    ].join("\n");
    return openCommandInTerminal(`codex-${connection.threadId}`, command);
  }
}

const launcher: HarnessLauncher = {
  id: "codex",
  launchFailedMessage: "Could not start Codex.",
  async check() {
    const bin = findRunnerBin("codex");
    if (!bin) return { ok: false, error: CODEX_MISSING_MESSAGE };
    if ((await readCodexAuth(bin)) === "signed_out") return { ok: false, error: CODEX_SIGNED_OUT_MESSAGE };
    return { ok: true, bin, version: await readCodexVersion(bin) };
  },
  newNativeSessionId: () => "",
  async launch({ sessionId, folderPath, model, bin }) {
    const server = await startAppServer(bin, sessionId);
    let connection: CodexConnection | null = null;
    try {
      const handlers = {
        onNotification: (method: string, params: unknown) => connection?.sink?.notification(method, params),
        onRequest: (id: number | string, method: string, params: unknown) => connection?.sink?.request(id, method, params),
        onClose: () => {},
      };
      const rpc = await connect(server, handlers);
      const started = await rpc.request<ThreadStartResult>("thread/start", {
        ...(model ? { model } : {}),
        cwd: folderPath,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      }).catch((error: Error) => {
        rpc.close();
        throw new LaunchError(`Codex could not start the session: ${error.message}`);
      });
      connection = new CodexConnection(server, started.thread.id, folderPath, bin);
      connection.rpc = rpc;
      live.set(sessionId, connection);
      return { nativeSessionId: started.thread.id };
    } catch (error) {
      server.stop();
      throw error;
    }
  },
};

export const codex: HarnessRegistration = { launcher, createDriver: (host) => new CodexDriver(host) };

export interface RpcHandlers {
  onNotification(method: string, params: unknown): void;
  /** A request from the server. Answer it with `respond` or `respondError`. */
  onRequest(id: number | string, method: string, params: unknown): void;
  onClose(): void;
}

interface Message {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_ATTEMPTS = 40;
const CONNECT_RETRY_MS = 250;

export class RpcError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

/** A JSON-RPC client over a WebSocket, for `codex app-server`. */
export class RpcClient {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;

  private constructor(private readonly ws: WebSocket, private readonly handlers: RpcHandlers) {
    ws.onmessage = (event) => this.receive(String(event.data));
    ws.onclose = () => this.shutdown();
    ws.onerror = () => this.shutdown();
  }

  /** The server may still be starting, so a failed connection is retried for a few seconds. */
  static async connect(url: string, token: string, handlers: RpcHandlers): Promise<RpcClient> {
    let lastError: unknown;
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
      try {
        const ws = await open(url, token);
        return new RpcClient(ws, handlers);
      } catch (error) {
        lastError = error;
        await new Promise((done) => setTimeout(done, CONNECT_RETRY_MS));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Could not connect to the Codex app server.");
  }

  isOpen(): boolean {
    return !this.closed;
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error("The Codex app server is not running."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: number | string, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  close(): void {
    this.shutdown();
    try {
      this.ws.close();
    } catch {}
  }

  private send(message: object): void {
    if (this.closed) return;
    this.ws.send(JSON.stringify(message));
  }

  private receive(text: string): void {
    let message: Message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.method !== undefined) {
      if (message.id !== undefined) this.handlers.onRequest(message.id, message.method, message.params);
      else this.handlers.onNotification(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new RpcError(message.error.message, message.error.code));
    else waiting.resolve(message.result);
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new Error("The Codex app server closed."));
      this.pending.delete(id);
    }
    this.handlers.onClose();
  }
}

function open(url: string, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Bun accepts request headers as a constructor option; the DOM typings do not know it.
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as never);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("Could not connect to the Codex app server."));
  });
}

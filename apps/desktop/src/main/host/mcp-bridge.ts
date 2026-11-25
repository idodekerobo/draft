import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { SessionMcpConnection } from "draft-core/host/drivers/harness-driver";
import { hostMcpDir } from "draft-core/host/cursor-store";
import { McpStatusStore } from "./mcp-status";
import { bufferMcpBody, McpTransportError, type SessionMcpBinding } from "./mcp-transport";

export { hostMcpDir };
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_ENV = "DRAFT_SESSION_MCP_TOKEN";

export class SessionMcpBridge {
  readonly status = new McpStatusStore();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private restoring: Promise<boolean> | null = null;
  private bindings = new Map<string, SessionMcpBinding & { token: string }>();
  private lease: string | null = null;
  private ownerNonce = crypto.randomUUID();
  constructor(private readonly options: {
    directory: string;
    apiUrl: string;
    workspaceId(): string | null;
    send(binding: SessionMcpBinding, request: Request): Promise<Response>;
  }) {}

  private path(name: string): string { return join(this.options.directory, name); }
  private read(name: string): unknown {
    try { return JSON.parse(readFileSync(this.path(name), "utf8")); } catch { return null; }
  }
  private write(name: string, value: unknown): void {
    const temporary = this.path(`${name}.${this.ownerNonce}.tmp`);
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, this.path(name));
  }
  private acquire(): boolean {
    const lease = this.path("owner");
    try { mkdirSync(lease, { mode: 0o700 }); }
    catch {
      const recovery = this.path("owner-recovery");
      try { mkdirSync(recovery, { mode: 0o700 }); } catch { return false; }
      try {
        const owner = JSON.parse(readFileSync(join(lease, "pid.json"), "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
        try { process.kill(owner.pid, 0); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
        rmSync(lease, { recursive: true });
        mkdirSync(lease, { mode: 0o700 });
      } catch { return false; }
      finally { rmSync(recovery, { recursive: true }); }
    }
    writeFileSync(join(lease, "pid.json"), JSON.stringify({ pid: process.pid, nonce: this.ownerNonce }), { mode: 0o600 });
    this.lease = lease;
    return true;
  }
  async restore(): Promise<boolean> {
    if (this.server) return true;
    if (this.restoring) return this.restoring;
    this.restoring = this.restoreOnce().finally(() => { this.restoring = null; });
    return this.restoring;
  }
  private async restoreOnce(): Promise<boolean> {
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
    if (!this.lease && !this.acquire()) return false;
    const saved = this.read("endpoint.json") as { port?: number; origin?: string } | null;
    const origin = new URL(this.options.apiUrl).origin;
    if (saved && (saved.origin !== origin || !Number.isInteger(saved.port) || saved.port! < 1 || saved.port! > 65535)) return false;
    try {
      this.server = Bun.serve({ hostname: "127.0.0.1", port: saved?.port ?? 0, fetch: (request) => this.handle(request) });
      this.write("endpoint.json", { port: this.server.port, origin });
      return true;
    } catch {
      if (this.server) { await this.server.stop(true); this.server = null; }
      return false;
    }
  }
  async prepare(binding: SessionMcpBinding, endpointId = binding.sessionId): Promise<SessionMcpConnection | undefined> {
    if (!SESSION.test(binding.sessionId) || !SESSION.test(endpointId)) return undefined;
    if (!this.bindings.has(endpointId)) this.status.set(binding.sessionId, { state: "connecting" });
    if (!await this.restore()) {
      this.status.set(binding.sessionId, { state: "unavailable", reason: "bridge_port_unavailable" });
      return undefined;
    }
    const saved = this.read(`${endpointId}.json`) as (SessionMcpBinding & { token?: string }) | null;
    if (saved && (saved.workspaceId !== binding.workspaceId || saved.hostId !== binding.hostId || !/^[a-f0-9]{64}$/.test(saved.token ?? ""))) {
      this.status.set(binding.sessionId, { state: "unavailable", reason: "connection_failed" });
      return undefined;
    }
    const token = saved?.token ?? crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    this.write(`${endpointId}.json`, { ...binding, token });
    writeFileSync(this.path(`${endpointId}.token`), token, { mode: 0o600 });
    this.bindings.set(endpointId, { ...binding, token });
    return { serverName: `draft_session_${endpointId.replaceAll("-", "_")}`, url: `http://127.0.0.1:${this.server!.port}/mcp/${endpointId}`, tokenEnvVar: TOKEN_ENV, token, tokenFile: this.path(`${endpointId}.token`) };
  }
  release(sessionId: string): void {
    for (const [endpointId, binding] of this.bindings) {
      if (binding.sessionId !== sessionId) continue;
      this.bindings.delete(endpointId);
      for (const suffix of ["json", "token"]) {
        try { unlinkSync(this.path(`${endpointId}.${suffix}`)); } catch { /* Already removed. */ }
      }
    }
    this.status.set(sessionId, null);
  }
  async transfer(fromSessionId: string, binding: SessionMcpBinding): Promise<void> {
    for (const [endpointId, previous] of this.bindings) {
      if (previous.sessionId === fromSessionId && previous.workspaceId === binding.workspaceId && previous.hostId === binding.hostId) {
        await this.prepare(binding, endpointId);
        this.status.set(fromSessionId, null);
      }
    }
  }
  disable(): void { this.bindings.clear(); this.status.clear(); }
  private failure(envelope: { method?: string; id?: unknown } | null, reason: string): Response {
    if (envelope && !("id" in envelope)) return new Response(null, { status: 202 });
    const message = reason === "sign_in_required" ? "Sign in to Draft to restore Draft tools." : "Draft tools are unavailable. Retry after Draft reconnects.";
    if (envelope?.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: envelope.id, result: { isError: true, content: [{ type: "text", text: message }] } });
    return Response.json({ jsonrpc: "2.0", id: envelope?.id ?? null, error: { code: -32001, message } }, { status: 503 });
  }
  private async handle(request: Request): Promise<Response> {
    const match = /^\/mcp\/([a-f0-9-]+)$/.exec(new URL(request.url).pathname);
    const binding = match ? this.bindings.get(match[1]!) : undefined;
    const token = /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!binding || Buffer.byteLength(token) !== Buffer.byteLength(binding.token) || !timingSafeEqual(Buffer.from(token), Buffer.from(binding.token))) return new Response(null, { status: 403 });
    let envelope: { method?: string; id?: unknown } | null = null;
    try {
      const body = await bufferMcpBody(request);
      if (body) {
        const parsed = JSON.parse(new TextDecoder().decode(body));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Response(null, { status: 400 });
        envelope = parsed;
      }
      if (this.options.workspaceId() !== binding.workspaceId) return this.failure(envelope, "sign_in_required");
      const forwarded = new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal });
      const response = await this.options.send(binding, forwarded);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const reason = response.status === 401 ? "sign_in_required" : "upstream_unavailable";
        this.status.set(binding.sessionId, { state: "unavailable", reason });
        return this.failure(envelope, reason);
      }
      this.status.set(binding.sessionId, { state: "ready" });
      const headers = new Headers(response.headers);
      headers.delete("www-authenticate"); headers.delete("location"); headers.delete("set-cookie");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      const reason = error instanceof McpTransportError ? error.reason : "upstream_unavailable";
      this.status.set(binding.sessionId, { state: "unavailable", reason });
      return this.failure(envelope, reason);
    }
  }
  async close(): Promise<void> {
    if (this.server) await this.server.stop(true);
    this.server = null;
    if (this.lease) {
      try {
        const owner = JSON.parse(readFileSync(join(this.lease, "pid.json"), "utf8"));
        if (owner.nonce === this.ownerNonce) rmSync(this.lease, { recursive: true });
      } catch { /* Another process owns the lease. */ }
    }
    this.lease = null;
    this.bindings.clear();
  }
}

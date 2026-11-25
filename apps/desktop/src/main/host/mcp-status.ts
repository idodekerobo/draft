import type { SessionMcpStatus, SessionMcpStatusUpdate } from "../../rpc/schema";

export class McpStatusStore {
  private revision = 0;
  private values = new Map<string, SessionMcpStatusUpdate>();
  private listeners = new Set<(update: SessionMcpStatusUpdate) => void>();
  get(sessionId: string): SessionMcpStatusUpdate {
    return this.values.get(sessionId) ?? { sessionId, revision: this.revision, status: null };
  }
  set(sessionId: string, status: SessionMcpStatus | null): void {
    const previous = this.values.get(sessionId)?.status ?? null;
    if (JSON.stringify(previous) === JSON.stringify(status)) return;
    const update = { sessionId, revision: ++this.revision, status };
    this.values.set(sessionId, update);
    for (const listener of this.listeners) listener(update);
  }
  clear(): void { for (const id of this.values.keys()) this.set(id, null); }
  subscribe(listener: (update: SessionMcpStatusUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

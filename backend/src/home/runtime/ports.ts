import type { AgentRunSpec } from "draft-core/run-spec";
import type { HomeSessionRef } from "./runs";

export interface PendingInput {
  id: string;
  kind: "message" | "permission_decision" | "stop" | "set_mode" | "end";
  state: "queued" | "delivering" | "uncertain";
  authorUserId: string;
  authorName: string;
  payload: Record<string, unknown>;
}

/** The database the host works against. A real one in the backend, an in-memory one in tests. */
export interface HostStore {
  claim(sessionId: string, owner: string, ttlSeconds: number): Promise<{ claimed: boolean; epoch: number }>;
  renew(sessionId: string, owner: string, epoch: number, ttlSeconds: number): Promise<boolean>;
  release(sessionId: string, owner: string, epoch: number): Promise<void>;
  /** Whether the claim is still this process's at this epoch and has not expired. Does not extend it. */
  stillOwner(sessionId: string, owner: string, epoch: number): Promise<boolean>;
  loadSession(sessionId: string): Promise<(HomeSessionRef & { ended: boolean }) | null>;
  /** Inputs not yet applied, oldest first. */
  pendingInputs(sessionId: string): Promise<PendingInput[]>;
  transition(inputId: string, sessionId: string, from: string[], to: string, reason: string | null): Promise<boolean>;
  setSessionModel(sessionId: string, model: string): Promise<void>;
  /** Backend sessions that have work and may have no owner: queued inputs, unprojected events or an open run. */
  sessionsNeedingRecovery(): Promise<string[]>;
}

export interface RunPort {
  open(session: HomeSessionRef, instructions: string): Promise<{ id: string; spec: AgentRunSpec }>;
  /** True when the run ended; false when work is still pending. */
  settle(sessionId: string, runId: string): Promise<boolean>;
}

/** How one backend process tells the one that owns a Home that it has work. A lost wake costs only the sweep's delay. */
export interface WakeBus {
  notify(sessionId: string): Promise<void>;
  listen(handler: (sessionId: string) => void): () => void;
}

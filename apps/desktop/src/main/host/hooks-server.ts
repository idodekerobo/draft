import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import type { HookAnswer } from "./approvals";
import { HOST_DIR } from "./hook-settings";

export interface SessionHooks {
  permission(payload: Record<string, unknown>, signal: AbortSignal): Promise<HookAnswer | null>;
  stopped(): void;
  /** Claude started or replaced its conversation; `/clear` and `/fork` give it a new session id. */
  sessionStarted(payload: Record<string, unknown>): void;
}

const sessions = new Map<string, SessionHooks>();
let server: ReturnType<typeof Bun.serve> | null = null;
let serverToken = "";
let endpointDir = HOST_DIR;

const endpointPath = (sessionId: string, name: "port" | "token") => `${endpointDir}/hooks/${sessionId}.${name}`;

/**
 * Each session has its own endpoint files, so another Draft process on the same computer (a dev build next to an
 * installed one) cannot take over this session's hooks. A restart writes them again when it takes the session back.
 */
function writeEndpoint(sessionId: string): void {
  mkdirSync(`${endpointDir}/hooks`, { recursive: true });
  for (const [name, value] of [["port", String(server!.port)], ["token", serverToken]] as const) {
    writeFileSync(endpointPath(sessionId, name), value);
    chmodSync(endpointPath(sessionId, name), 0o600);
  }
}

export function registerSessionHooks(sessionId: string, hooks: SessionHooks): () => void {
  sessions.set(sessionId, hooks);
  writeEndpoint(sessionId);
  return () => {
    if (sessions.get(sessionId) !== hooks) return;
    sessions.delete(sessionId);
    rmSync(endpointPath(sessionId, "port"), { force: true });
    rmSync(endpointPath(sessionId, "token"), { force: true });
  };
}

export function hookOutput(answer: HookAnswer): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: answer } });
}

async function readPayload(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Starts the local hook server once. The hook script finds it through a session's endpoint files. */
export function ensureHooksServer(dir = HOST_DIR): void {
  if (server) return;
  endpointDir = dir;
  const token = (serverToken = crypto.randomUUID());
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, bunServer) {
      const url = new URL(req.url);
      const match = /^\/hook\/([^/]+)\/(permission|stop|session-start)$/.exec(url.pathname);
      if (req.method !== "POST" || !match || req.headers.get("x-draft-token") !== token) return new Response("not found", { status: 404 });
      const hooks = sessions.get(match[1]!);
      if (!hooks) return new Response(null, { status: 204 });

      if (match[2] === "stop") {
        hooks.stopped();
        return new Response(null, { status: 204 });
      }
      if (match[2] === "session-start") {
        hooks.sessionStarted(await readPayload(req));
        return new Response(null, { status: 204 });
      }
      bunServer.timeout(req, 0);
      const answer = await hooks.permission(await readPayload(req), req.signal);
      return answer ? new Response(hookOutput(answer), { headers: { "content-type": "application/json" } }) : new Response(null, { status: 204 });
    },
  });
}

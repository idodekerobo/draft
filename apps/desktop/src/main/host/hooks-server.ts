import { chmodSync, mkdirSync, writeFileSync } from "fs";
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

export function registerSessionHooks(sessionId: string, hooks: SessionHooks): () => void {
  sessions.set(sessionId, hooks);
  return () => {
    if (sessions.get(sessionId) === hooks) sessions.delete(sessionId);
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

/** Starts the local hook server once. The hook script finds it through the port and token files. */
export function ensureHooksServer(dir = HOST_DIR): void {
  if (server) return;
  const token = crypto.randomUUID();
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
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of [["hooks.port", String(server.port)], ["hooks.token", token]] as const) {
    writeFileSync(`${dir}/${name}`, value);
    chmodSync(`${dir}/${name}`, 0o600);
  }
}

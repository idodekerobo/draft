import { recordError } from "../../errors/record-error";

type Waker = (sessionId: string) => Promise<void>;
let waker: Waker | undefined;

/** Set by Home's bootstrap. Until it is set (tests, or Home off) a wake does nothing. */
export function setHomeWaker(next: Waker | undefined): void {
  waker = next;
}

/** Tells Home that a saved input is waiting. Does nothing for a session Home does not run. Never throws. */
export async function wakeHomeSession(sessionId: string): Promise<void> {
  try {
    await waker?.(sessionId);
  } catch (error) {
    void recordError({ workspaceId: null, sessionId, operation: "session", code: "home_wake_failed", message: "Waking Home after a saved input failed", error });
  }
}

type SessionHandler = (req: Bun.BunRequest<string> & { params: { sessionId: string } }) => Response | Promise<Response>;

/** After a route that saved an input answers well, wakes Home for that session, without making the caller wait for it. */
export function wakingHome<H extends (req: never) => Response | Promise<Response>>(handler: H): H {
  return (async (req: Parameters<H>[0]) => {
    const response = await handler(req);
    const sessionId = (req as unknown as { params?: { sessionId?: string } }).params?.sessionId;
    if (response.ok && sessionId) void wakeHomeSession(sessionId);
    return response;
  }) as unknown as H;
}
export type { SessionHandler };

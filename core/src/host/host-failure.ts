import { hostErrorAction } from "../live-sessions";
import { ServerError, SessionExpiredError } from "./services";

/**
 * What a session host does after a failure: stop for good, pause until the right login, or try again later.
 * A signed-out app pauses, so no loop keeps calling a server it cannot reach.
 */
export function hostFailureAction(error: unknown): "stop" | "pause" | "retry" {
  if (error instanceof SessionExpiredError) return "pause";
  return error instanceof ServerError ? hostErrorAction(error.code) : "retry";
}

/** Sent by the desktop app and by the web app's server, which make no browser request and so carry no Origin. */
export const APP_CLIENT_HEADER = "x-draft-client";

const APP_CLIENTS = new Set(["web", "desktop"]);

/**
 * Only agents (the CLI, and anything else calling with a bare token) count as agent usage.
 * The web app's browser sends an Origin; its server and the desktop app send APP_CLIENT_HEADER.
 */
export function isAgentRequest(req: Request): boolean {
  if (req.headers.has("origin")) return false;
  return !APP_CLIENTS.has(req.headers.get(APP_CLIENT_HEADER) ?? "");
}

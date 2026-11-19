/** Sent by the desktop app and by the web app's server, which make no browser request and so carry no Origin. */
export const APP_CLIENT_HEADER = "x-draft-client";

export function callSurface(req: Request): "web_app" | "desktop_app" | "cli" {
  const client = req.headers.get(APP_CLIENT_HEADER);
  if (client === "desktop") return "desktop_app";
  if (client === "web" || req.headers.has("origin")) return "web_app";
  return "cli";
}

/**
 * Only agents (the CLI, and anything else calling with a bare token) count as agent usage.
 * The web app's browser sends an Origin; its server and the desktop app send APP_CLIENT_HEADER.
 */
export function isAgentRequest(req: Request): boolean {
  return callSurface(req) === "cli";
}

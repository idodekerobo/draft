import * as firefliesWebhook from "../webhooks/fireflies/route";
import * as granolaWebhook from "../webhooks/granola/route";
import * as githubWebhook from "../webhooks/github/route";
import * as linearWebhook from "../webhooks/linear/route";
import * as connections from "./connections";
import * as githubCallback from "./github-callback";
import * as githubInstall from "./github-install";
import * as health from "./health";
import * as mePrivacy from "./me-privacy";
import * as onboarding from "./onboarding";
import * as sandboxCallback from "./sandbox-callback";
import * as sessionProjects from "./session-projects";
import * as sessionsIngest from "./sessions-ingest";
import * as sessionsIngestErrors from "./sessions-ingest-errors";
import * as sessionsSearch from "./sessions-search";
import * as sessionTokens from "./session-tokens";
import * as sessionTokensRotate from "./session-tokens-rotate";
import * as sessionTokensRevoke from "./session-tokens-revoke";
import * as sessions from "./sessions";
import * as schedules from "./schedules";
import * as skills from "./skills";
import * as sourceItems from "./source-items";
import * as sources from "./sources";
import * as synthesisRuns from "./synthesis-runs";
import * as synthesisSchedule from "./synthesis-schedule";
import * as whoami from "./whoami";
import * as waitlist from "./waitlist";
import * as workspaceContext from "./workspace-context";
import * as invites from "../auth/invite-routes";
import * as links from "../auth/link-routes";
import { OPTIONS, withCors } from "../auth/with-cors";
import { AUTH_HANDLER, WELL_KNOWN_HANDLER } from "../auth/better-auth-routes";
import * as oauthConsentRedirect from "../auth/oauth-consent-redirect";
import * as mcp from "../mcp/route";

export const routes = {
  "/health": { GET: health.GET },
  "/whoami": { GET: withCors(whoami.GET), OPTIONS },
  "/waitlist": { POST: waitlist.POST },
  "/onboarding-complete": { POST: onboarding.POST, OPTIONS },
  "/me/privacy": { PATCH: withCors(mePrivacy.PATCH), OPTIONS },
  "/workspaces/:id/context": { GET: withCors(workspaceContext.contextGET), OPTIONS },
  "/workspaces/:id/connections": { GET: withCors(connections.GET), POST: withCors(connections.POST), OPTIONS },
  "/workspaces/:id/connections/:provider": { PATCH: withCors(connections.PATCH), DELETE: withCors(connections.DELETE), OPTIONS },
  "/workspaces/:id/connections/:provider/channels": { GET: withCors(connections.CHANNELS_GET), OPTIONS },
  "/workspaces/:id/synthesis-runs": { GET: withCors(synthesisRuns.GET), POST: withCors(synthesisRuns.POST), OPTIONS },
  "/workspaces/:id/synthesis-schedule": { GET: withCors(synthesisSchedule.GET), PATCH: withCors(synthesisSchedule.PATCH), OPTIONS },
  "/workspaces/:id/schedules": { GET: withCors(schedules.GET), OPTIONS },
  "/workspaces/:id/schedules/:taskId": { PATCH: withCors(schedules.PATCH), OPTIONS },
  "/workspaces/:id/source-items": { POST: sourceItems.POST },
  "/workspaces/:id/sources/search": { POST: sources.searchPOST },
  "/workspaces/:id/sources/:sourceItemId/read": { POST: sources.readPOST },
  "/workspaces/:id/github/install-sessions": { POST: githubInstall.createPOST },
  "/workspaces/:id/github/install-sessions/:code": { GET: githubInstall.pollGET },
  "/workspaces/github/callback": { GET: githubCallback.GET },
  "/workspaces/:id/sessions/tokens": { POST: sessionTokens.POST },
  "/workspaces/:id/sessions/tokens/:credentialId": { DELETE: sessionTokens.DELETE },
  "/workspaces/:id/sessions": { GET: sessions.GET },
  "/workspaces/:id/sessions/projects": { GET: withCors(sessionProjects.GET), OPTIONS },
  "/workspaces/:id/sessions/search": { GET: sessionsSearch.GET },
  "/workspaces/:id/sessions/:sessionId": { GET: sessions.READ },
  "/workspaces/:id/skills": { GET: skills.skillsGET, POST: skills.skillsPOST },
  "/workspaces/:id/skills/:name": { GET: skills.skillsREAD, PATCH: skills.skillsPATCH, DELETE: skills.skillsDELETE },
  "/sessions/ingest": { POST: sessionsIngest.POST },
  "/sessions/ingest-errors": { POST: sessionsIngestErrors.POST },
  "/sessions/tokens/rotate": { POST: sessionTokensRotate.POST },
  "/sessions/tokens/revoke": { POST: sessionTokensRevoke.POST },
  "/invites/mine": { GET: invites.mineGET },
  "/invites/:token": { GET: withCors(invites.resolveGET), OPTIONS },
  "/invites/:token/accept": { POST: withCors(invites.acceptPOST), OPTIONS },
  "/link": { POST: links.createPOST },
  "/link/:code": { GET: links.pollGET },
  "/link/:code/approve": { POST: withCors(links.approvePOST), OPTIONS },
  "/sandbox/callback": { POST: sandboxCallback.POST },
  // Wildcard covers every Better Auth path under its "/api/auth" basePath
  // (oauth2/authorize, oauth2/token, oauth2/consent, our bridge endpoint, etc).
  // Better Auth emits no CORS headers itself, so the browser-called paths
  // under it (the bridge endpoint, oauth2/consent) need withCors here too.
  "/api/auth/*": { GET: withCors(AUTH_HANDLER), POST: withCors(AUTH_HANDLER), OPTIONS },
  // Top-level-navigation front for the POST-only /oauth2/consent — see
  // oauth-consent-redirect.ts for why the consent page can't call it via fetch.
  "/oauth2/consent-redirect": { GET: oauthConsentRedirect.GET },
  // RFC 9728/8414 discovery docs live at root, outside the basePath. Both
  // the bare path and the RFC 8414/9728 path-appended form (for the
  // "/api/auth" issuer and "/mcp" resource) are valid; Better Auth's handler
  // recognizes both itself, but Bun's router needs an explicit entry for each.
  "/.well-known/oauth-authorization-server": { GET: WELL_KNOWN_HANDLER },
  "/.well-known/oauth-authorization-server/api/auth": { GET: WELL_KNOWN_HANDLER },
  "/.well-known/openid-configuration": { GET: WELL_KNOWN_HANDLER },
  "/.well-known/openid-configuration/api/auth": { GET: WELL_KNOWN_HANDLER },
  "/.well-known/oauth-protected-resource": { GET: WELL_KNOWN_HANDLER },
  "/.well-known/oauth-protected-resource/mcp": { GET: WELL_KNOWN_HANDLER },
  "/mcp": { GET: mcp.GET, POST: mcp.POST, DELETE: mcp.DELETE },
  "/webhooks/fireflies/:connectionKey": { POST: firefliesWebhook.POST },
  "/webhooks/granola/:connectionKey": { POST: granolaWebhook.POST },
  "/webhooks/linear/:connectionKey": { POST: linearWebhook.POST },
  "/webhooks/github": { POST: githubWebhook.POST },
};

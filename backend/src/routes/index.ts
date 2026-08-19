import * as firefliesWebhook from "../webhooks/fireflies/route";
import * as githubWebhook from "../webhooks/github/route";
import * as linearWebhook from "../webhooks/linear/route";
import * as connections from "./connections";
import * as health from "./health";
import * as onboarding from "./onboarding";
import * as sandboxCallback from "./sandbox-callback";
import * as sourceItems from "./source-items";
import * as synthesisRuns from "./synthesis-runs";
import * as whoami from "./whoami";
import * as workspaceContext from "./workspace-context";
import * as invites from "../auth/invite-routes";
import * as links from "../auth/link-routes";
import { OPTIONS, withCors } from "../auth/with-cors";

export const routes = {
  "/health": { GET: health.GET },
  "/whoami": { GET: withCors(whoami.GET), OPTIONS },
  "/onboarding-complete": { POST: onboarding.POST, OPTIONS },
  "/workspaces/:id/context": { GET: workspaceContext.contextGET },
  "/workspaces/:id/connections": { GET: connections.GET, POST: connections.POST },
  "/workspaces/:id/connections/:provider": { PATCH: connections.PATCH, DELETE: connections.DELETE },
  "/workspaces/:id/connections/:provider/channels": { GET: connections.CHANNELS_GET },
  "/workspaces/:id/synthesis-runs": { GET: synthesisRuns.GET, POST: synthesisRuns.POST },
  "/workspaces/:id/source-items": { POST: sourceItems.POST },
  "/invites/mine": { GET: invites.mineGET },
  "/invites/:token": { GET: withCors(invites.resolveGET), OPTIONS },
  "/invites/:token/accept": { POST: withCors(invites.acceptPOST), OPTIONS },
  "/link": { POST: links.createPOST },
  "/link/:code": { GET: links.pollGET },
  "/link/:code/approve": { POST: withCors(links.approvePOST), OPTIONS },
  "/sandbox/callback": { POST: sandboxCallback.POST },
  "/webhooks/fireflies/:connectionKey": { POST: firefliesWebhook.POST },
  "/webhooks/linear/:connectionKey": { POST: linearWebhook.POST },
  "/webhooks/github": { POST: githubWebhook.POST },
};

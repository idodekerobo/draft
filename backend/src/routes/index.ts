import * as firefliesWebhook from "../webhooks/fireflies/route";
import * as health from "./health";
import * as sandboxCallback from "./sandbox-callback";
import * as whoami from "./whoami";
import * as workspaceContext from "./workspace-context";
import * as invites from "../auth/invite-routes";
import * as links from "../auth/link-routes";
import { OPTIONS, withCors } from "../auth/with-cors";

export const routes = {
  "/health": { GET: health.GET },
  "/whoami": { GET: withCors(whoami.GET), OPTIONS },
  "/workspaces/:id/context": { GET: workspaceContext.contextGET },
  "/workspaces/:id/context/documents/*": { GET: workspaceContext.documentGET },
  "/invites/:token": { GET: withCors(invites.resolveGET), OPTIONS },
  "/invites/:token/accept": { POST: withCors(invites.acceptPOST), OPTIONS },
  "/link": { POST: links.createPOST },
  "/link/:code": { GET: links.pollGET },
  "/link/:code/approve": { POST: withCors(links.approvePOST), OPTIONS },
  "/sandbox/callback": { POST: sandboxCallback.POST },
  "/webhooks/fireflies/:connectionKey": { POST: firefliesWebhook.POST },
};

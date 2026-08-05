import * as firefliesWebhook from "../webhooks/fireflies/route";
import * as health from "./health";
import * as sandboxCallback from "./sandbox-callback";
import * as whoami from "./whoami";

export const routes = {
  "/health": { GET: health.GET },
  "/whoami": { GET: whoami.GET },
  "/sandbox/callback": { POST: sandboxCallback.POST },
  "/webhooks/fireflies/:connectionKey": { POST: firefliesWebhook.POST },
};

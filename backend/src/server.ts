import { loadConfig } from "./config";
import { startSlackListeners } from "./ingestion/slack/bootstrap";
import { startScheduler } from "./scheduling/bootstrap";
import { routes } from "./routes";
import { recordError } from "./errors/record-error";

const config = loadConfig();

Bun.serve({
  port: config.port,
  routes,
  fetch() {
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

startSlackListeners().catch((error) => {
  void recordError({
    workspaceId: null,
    operation: "ingestion",
    message: "Failed to start Slack listeners",
    code: "slack_listener_startup_failed",
    error,
  });
});
startScheduler();

console.log(`draft-backend listening on :${config.port}`);

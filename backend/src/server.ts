import { loadConfig } from "./config";
import { startSlackListeners } from "./ingestion/slack/bootstrap";
import { startScheduler } from "./scheduling/bootstrap";
import { registerWorkflows } from "./routines/register-workflows";
import { routes } from "./routes";
import { startHome, stopHome } from "./home/runtime/bootstrap";
import { recordError } from "./errors/record-error";

const config = loadConfig();
registerWorkflows();

Bun.serve({
  port: config.port,
  // Run now waits for the sandbox to boot (up to 60 s); Bun's 10 s default would drop the request.
  idleTimeout: 120,
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
startHome();

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void stopHome().finally(() => process.exit(0)));
}

console.log(`draft-backend listening on :${config.port}`);

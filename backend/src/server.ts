import { loadConfig } from "./config";
import { routes } from "./routes";

const config = loadConfig();

Bun.serve({
  port: config.port,
  routes,
  fetch() {
    return Response.json({ error: "not_found" }, { status: 404 });
  },
});

console.log(`draft-backend listening on :${config.port}`);

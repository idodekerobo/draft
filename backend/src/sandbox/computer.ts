// Entry of the computer server in a sandbox machine. Bundled by `bun run build:computer`.
import { createComputerServer } from "./computer/server";

const token = process.env.DRAFT_COMPUTER_TOKEN;
if (!token || token.length < 32) {
  console.error("[computer] fatal: DRAFT_COMPUTER_TOKEN must be at least 32 characters");
  process.exit(1);
}
const root = process.env.DRAFT_COMPUTER_ROOT ?? "/data/workspace";
const server = createComputerServer({ token, root, stateDir: process.env.DRAFT_COMPUTER_STATE ?? "/data/.draft/computer" });
await server.recover();
Bun.serve({ port: Number(process.env.DRAFT_COMPUTER_PORT ?? 8080), hostname: "0.0.0.0", idleTimeout: 120, fetch: server.fetch });
console.log("[computer] listening");

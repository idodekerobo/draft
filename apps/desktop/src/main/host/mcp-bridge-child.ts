import { SessionMcpBridge } from "./mcp-bridge";

const bridge = new SessionMcpBridge({ directory: process.argv[2]!, apiUrl: "https://api.test", workspaceId: () => "workspace", send: async () => Response.json({ result: {} }) });
const connection = await bridge.prepare({ sessionId: "11111111-1111-4111-8111-111111111111", workspaceId: "workspace", hostId: "host" });
process.stdout.write(JSON.stringify({ url: connection?.url ?? null }) + "\n");
process.stdin.resume();
process.stdin.once("data", async () => { await bridge.close(); process.exit(0); });

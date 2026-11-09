import { createRunGateway } from "../agent-runs/run-gateway";
import { runTokenSecret } from "../agent-runs/run-token-secret";
import { createDraftToolRegistry } from "../agent-runs/tools";
import { serviceClient } from "../db/client";

// Built on first use so a backend without the secret still starts.
let gateway: ReturnType<typeof createRunGateway> | null = null;
function runGateway() {
  gateway ??= createRunGateway({ client: serviceClient, secret: () => runTokenSecret(), registry: createDraftToolRegistry(serviceClient) });
  return gateway;
}

export const toolsGET = (req: Bun.BunRequest<"/runs/:runId/tools">) => runGateway().listTools(req, req.params.runId);

export const toolPOST = (req: Bun.BunRequest<"/runs/:runId/tools/:name">) =>
  runGateway().callTool(req, req.params.runId, req.params.name);

export const mcpHandler = (req: Bun.BunRequest<"/runs/:runId/mcp">) => runGateway().mcp(req, req.params.runId);

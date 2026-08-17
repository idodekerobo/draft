import { ingestLinearEvent } from "../../ingestion/linear/normalize";
import { authenticateLinearWebhookRequest, LinearWebhookAuthError } from "./request-auth";
import { recordRouteError } from "../../errors/route-error";

export async function POST(
  request: Bun.BunRequest<"/webhooks/linear/:connectionKey">,
): Promise<Response> {
  let workspaceId: string | null = null;
  let sourceConnectionId: string | null = null;
  try {
    const { connection, payload } = await authenticateLinearWebhookRequest(
      request,
      request.params.connectionKey,
    );
    workspaceId = connection.workspace_id;
    sourceConnectionId = connection.id;

    console.log(`[linear webhook] ${payload.type}.${payload.action}`, JSON.stringify(payload, null, 2));

    await ingestLinearEvent(connection, payload);

    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof LinearWebhookAuthError) {
      console.log(`[linear webhook] auth failed for connectionKey=${request.params.connectionKey}: ${error.message}`);
      return new Response(null, { status: 401 });
    }
    recordRouteError({
      workspaceId,
      sourceConnectionId,
      operation: "ingestion",
      errorCode: "linear_webhook_failed",
      error,
    });
    return new Response(null, { status: 500 });
  }
}

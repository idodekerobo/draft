import { ingestLinearEvent, type LinearWebhookPayload } from "../../ingestion/linear/normalize";
import { linearIssueFacts } from "../../routines/event-facts";
import { fireEnqueueRoutineEvents } from "../../events/enqueue-routine-events";
import { authenticateLinearWebhookRequest, LinearWebhookAuthError } from "./request-auth";
import { recordRouteError } from "../../errors/route-error";

/** An issue created, or moved into a completed state by this update. */
function linearTrigger(payload: LinearWebhookPayload): "linear.issue_created" | "linear.issue_completed" | null {
  if (payload.type !== "Issue") return null;
  if (payload.action === "create") return "linear.issue_created";
  const state = payload.data.state as { type?: unknown } | undefined;
  const stateChanged = !!(payload as { updatedFrom?: { stateId?: unknown } }).updatedFrom?.stateId;
  return payload.action === "update" && state?.type === "completed" && stateChanged ? "linear.issue_completed" : null;
}

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

    console.log(`[linear webhook] ${payload.type}.${payload.action}`);

    const ingested = await ingestLinearEvent(connection, payload);
    const name = linearTrigger(payload);
    if (name && "sourceItemId" in ingested && typeof payload.data.id === "string") {
      fireEnqueueRoutineEvents({ workspaceId: connection.workspace_id, sourceConnectionId: connection.id, name, eventId: payload.data.id, sourceItemId: ingested.sourceItemId, facts: linearIssueFacts(payload), concurrencyKey: `linear:${payload.data.id}` });
    }

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

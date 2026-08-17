import { ingestFirefliesMeeting } from "../../ingestion/fireflies/normalize";
import { authenticateFirefliesWebhookRequest, FirefliesWebhookAuthError } from "./request-auth";
import { recordRouteError } from "../../errors/route-error";

const HANDLED_EVENTS = new Set(["meeting.summarized", "meeting.transcribed"]);

export async function POST(
  request: Bun.BunRequest<"/webhooks/fireflies/:connectionKey">,
): Promise<Response> {
  let workspaceId: string | null = null;
  let sourceConnectionId: string | null = null;
  try {
    const { connection, event, meetingId } = await authenticateFirefliesWebhookRequest(
      request,
      request.params.connectionKey,
    );
    workspaceId = connection.workspace_id;
    sourceConnectionId = connection.id;

    if (HANDLED_EVENTS.has(event)) {
      await ingestFirefliesMeeting(connection, meetingId);
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof FirefliesWebhookAuthError) {
      return new Response(null, { status: 401 });
    }
    recordRouteError({
      workspaceId,
      sourceConnectionId,
      operation: "ingestion",
      errorCode: "fireflies_webhook_failed",
      error,
    });
    return new Response(null, { status: 500 });
  }
}

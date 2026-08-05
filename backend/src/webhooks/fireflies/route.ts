import { ingestFirefliesMeeting } from "../../ingestion/fireflies/normalize";
import { authenticateFirefliesWebhookRequest, FirefliesWebhookAuthError } from "./request-auth";

const HANDLED_EVENTS = new Set(["meeting.summarized", "meeting.transcribed"]);

export async function POST(
  request: Bun.BunRequest<"/webhooks/fireflies/:connectionKey">,
): Promise<Response> {
  try {
    const { connection, event, meetingId } = await authenticateFirefliesWebhookRequest(
      request,
      request.params.connectionKey,
    );

    if (HANDLED_EVENTS.has(event)) {
      await ingestFirefliesMeeting(connection, meetingId);
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof FirefliesWebhookAuthError) {
      return new Response(null, { status: 401 });
    }
    console.error("fireflies webhook POST failed", error);
    return new Response(null, { status: 500 });
  }
}

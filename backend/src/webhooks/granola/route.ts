import { meetingFacts } from "../../routines/event-facts";
import { fireEnqueueRoutineEvents } from "../../events/enqueue-routine-events";
import { ingestGranolaNote } from "../../ingestion/granola/normalize";
import { authenticateGranolaWebhookRequest, GranolaWebhookAuthError } from "./request-auth";
import { recordRouteError } from "../../errors/route-error";
import { serviceClient } from "../../db/client";

// note.access_granted is included so a note newly shared with this key gets
// the same fetch-and-ingest as a freshly generated one.
const HANDLED_EVENTS = new Set(["note.generated", "note.edited", "note.access_granted"]);

/** Handles a Granola webhook delivery: authenticates, ingests the note, records success. */
export async function POST(
  request: Bun.BunRequest<"/webhooks/granola/:connectionKey">,
): Promise<Response> {
  let workspaceId: string | null = null;
  let sourceConnectionId: string | null = null;
  try {
    const { connection, credentialId, eventType, noteId } = await authenticateGranolaWebhookRequest(
      request,
      request.params.connectionKey,
    );
    workspaceId = connection.workspace_id;
    sourceConnectionId = connection.id;

    // An unrecognized event type is a 2xx no-op, not an error -- otherwise
    // Granola retries and eventually disables the endpoint.
    let generatedSourceItemId: string | null = null;
    if (HANDLED_EVENTS.has(eventType)) {
      const ingested = await ingestGranolaNote(connection, credentialId, noteId);
      if (eventType === "note.generated") generatedSourceItemId = ingested.sourceItemId;
    }

    const { error } = await serviceClient.rpc("mark_granola_webhook_success", {
      p_workspace_id: connection.workspace_id,
      p_connection_id: connection.id,
      p_credential_id: credentialId,
      p_succeeded_at: new Date().toISOString(),
    });
    if (error) throw error;

    if (generatedSourceItemId) {
      fireEnqueueRoutineEvents({ workspaceId: connection.workspace_id, sourceConnectionId: connection.id, name: "granola.note_ready", eventId: noteId, sourceItemId: generatedSourceItemId, facts: meetingFacts("Granola note id", noteId), concurrencyKey: `granola:${noteId}` });
    }

    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof GranolaWebhookAuthError) {
      return new Response(null, { status: 401 });
    }
    recordRouteError({
      workspaceId,
      sourceConnectionId,
      operation: "ingestion",
      errorCode: "granola_webhook_failed",
      error,
    });
    return new Response(null, { status: 500 });
  }
}

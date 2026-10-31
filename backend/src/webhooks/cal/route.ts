import { recordError } from "../../errors/record-error";
import { handleBookingCreated } from "../../waitlist/booking";
import { defaultEventDeps } from "../../waitlist/events";
import { supabaseSignupStore } from "../../waitlist/signup-store";
import { parseBookingCreated } from "./payload";
import { authenticateCalWebhookRequest, CalWebhookAuthError } from "./request-auth";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await authenticateCalWebhookRequest(request);
    // Anything other than a new booking (including Cal's PING test) is acknowledged and ignored.
    if ((body as { triggerEvent?: unknown } | null)?.triggerEvent !== "BOOKING_CREATED") {
      return new Response(null, { status: 200 });
    }

    const booking = parseBookingCreated(body);
    if (!booking) {
      console.log("[cal webhook] BOOKING_CREATED payload had no attendee email or uid");
      return new Response(null, { status: 200 });
    }

    const landingUrl = process.env.DRAFT_LANDING_URL?.replace(/\/$/, "");
    await handleBookingCreated(booking, {
      store: supabaseSignupStore(),
      events: defaultEventDeps(),
      fallbackSourceUrl: landingUrl ? `${landingUrl}/getstarted` : undefined,
    });
    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof CalWebhookAuthError) {
      console.log(`[cal webhook] auth failed: ${error.message}`);
      return new Response(null, { status: 401 });
    }
    await recordError({
      workspaceId: null,
      allowUnattributed: true,
      operation: "ingestion",
      message: "Cal booking webhook failed",
      error,
    });
    return new Response(null, { status: 500 });
  }
}

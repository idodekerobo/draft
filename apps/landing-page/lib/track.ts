import posthog from "posthog-js";
import { EVENTS } from "@/lib/analytics";

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
  }
}

function capture(event: string, properties: Record<string, unknown>) {
  if (posthog.__loaded) posthog.capture(event, properties);
}

// PostHog and Meta get the same event_id so a later server-side send can dedupe.
export function trackWaitlistSignup(source: string) {
  const eventId = crypto.randomUUID();
  capture(EVENTS.WAITLIST_SUBMITTED, { source, event_id: eventId });
  window.fbq?.("track", "Lead", { content_name: source }, { eventID: eventId });
}

export function trackCallBooked(source: string) {
  const eventId = crypto.randomUUID();
  capture(EVENTS.CALL_BOOKED, { source, event_id: eventId });
  window.fbq?.("track", "Schedule", { content_name: source }, { eventID: eventId });
}

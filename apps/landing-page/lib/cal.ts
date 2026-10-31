import { getAttribution, getSubmitAttribution } from "@/lib/attribution";
import { profileToCalPrefill, type ProfileAnswers } from "@/lib/waitlist-questions";

// NEXT_PUBLIC_CAL_LINK lets staging point at a throwaway event type.
export const CAL_PATH = process.env.NEXT_PUBLIC_CAL_LINK ?? "idode/learn-about-draft";
export const CAL_NAMESPACE = CAL_PATH.split("/").pop() ?? "learn-about-draft";

const METADATA_ATTRIBUTION_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ttclid", "fbclid", "fbp", "fbc", "gpc"];

// Cal returns booking metadata in its webhook. It lets the backend report the booking to Meta with
// the same event id the browser used, and attribute a booking from someone who never signed up.
export function createCalMetadata(eventId: string, source: string): Record<string, string> {
  const last = getSubmitAttribution().last ?? {};
  const metadata: Record<string, string> = {
    "metadata[event_id]": eventId,
    "metadata[source]": source,
    "metadata[source_url]": window.location.href,
  };
  for (const key of METADATA_ATTRIBUTION_KEYS) {
    if (last[key]) metadata[`metadata[${key}]`] = last[key];
  }
  return metadata;
}

export function buildCalConfig(email: string, profile: ProfileAnswers, metadata: Record<string, string> = {}) {
  const last = getAttribution().last ?? {};
  const utm = Object.fromEntries(Object.entries(last).filter(([key]) => key.startsWith("utm_")));
  return {
    layout: "month_view" as const,
    ...(email ? { email } : {}),
    ...profileToCalPrefill(profile),
    ...utm,
    ...metadata,
  };
}

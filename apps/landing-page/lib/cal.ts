import { getAttribution } from "@/lib/attribution";
import { profileToCalPrefill, type ProfileAnswers } from "@/lib/waitlist-questions";

// NEXT_PUBLIC_CAL_LINK lets staging point at a throwaway event type.
export const CAL_PATH = process.env.NEXT_PUBLIC_CAL_LINK ?? "idode/learn-about-draft";
export const CAL_NAMESPACE = CAL_PATH.split("/").pop() ?? "learn-about-draft";

export function buildCalConfig(email: string, profile: ProfileAnswers) {
  const last = getAttribution().last ?? {};
  const utm = Object.fromEntries(Object.entries(last).filter(([key]) => key.startsWith("utm_")));
  return {
    layout: "month_view" as const,
    ...(email ? { email } : {}),
    ...profileToCalPrefill(profile),
    ...utm,
  };
}

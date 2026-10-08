import { getAttribution, getVisitorId } from "@/lib/attribution";
import { trackWaitlistSignup } from "@/lib/track";

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Request to ${path} failed`);
}

export async function submitWaitlist(email: string, source: string) {
  await post("/api/waitlist", {
    email,
    source,
    attribution: getAttribution(),
    posthog_distinct_id: getVisitorId(),
  });
  trackWaitlistSignup(source);
}

export function submitWaitlistProfile(email: string, profile: { how_heard: string; use_case: string; team_size: string }) {
  return post("/api/waitlist/profile", {
    email,
    posthog_distinct_id: getVisitorId(),
    profile,
  });
}

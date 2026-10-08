import { getAttribution, getVisitorId } from "@/lib/attribution";

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Request to ${path} failed`);
}

export function submitWaitlist(email: string, source: string) {
  return post("/api/waitlist", {
    email,
    source,
    attribution: getAttribution(),
    posthog_distinct_id: getVisitorId(),
  });
}

export function submitWaitlistProfile(email: string, profile: { how_heard: string; use_case: string; team_size: string }) {
  return post("/api/waitlist/profile", {
    email,
    posthog_distinct_id: getVisitorId(),
    profile,
  });
}

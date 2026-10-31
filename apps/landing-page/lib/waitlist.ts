import { getAttribution, getVisitorId } from "@/lib/attribution";
import { trackWaitlistSignup } from "@/lib/track";
import { PROFILE_VERSION, type ProfileAnswers } from "@/lib/waitlist-questions";

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Request to ${path} failed`);
  return response.json();
}

export async function submitWaitlist(email: string, source: string) {
  const result = await post("/api/waitlist", {
    email,
    source,
    attribution: getAttribution(),
    posthog_distinct_id: getVisitorId(),
  });
  trackWaitlistSignup(source);
  return result as { signup_token: string };
}

export function submitWaitlistProfile(signupToken: string, profile: ProfileAnswers) {
  return post("/api/waitlist/profile", {
    signup_token: signupToken,
    profile: { ...profile, profile_version: PROFILE_VERSION },
  });
}

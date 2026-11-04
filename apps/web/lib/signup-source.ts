import type { SignupSource } from "draft-shared-ui";

/** `src` comes from a URL anyone can edit, so only known values pass through. */
export function parseSignupSource(value: string | string[] | null | undefined): SignupSource {
  return value === "download" || value === "join" || value === "desktop" ? value : "direct";
}

/** The create-company URL, keeping where the creator came from and where to go afterwards. */
export function createOrgPath(source: SignupSource, next?: string): string {
  const params = new URLSearchParams();
  if (source !== "direct") params.set("src", source);
  if (next) params.set("next", next);
  const query = params.toString();
  return query ? `/onboarding/create?${query}` : "/onboarding/create";
}

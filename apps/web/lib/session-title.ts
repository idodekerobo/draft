import { cache } from "react";
import { API_URL } from "./config";

const FALLBACK = "Draft session";
const SESSION_PATH = /^\/sessions\/([0-9a-f-]{36})(?:[?#/]|$)/i;

const fetchTitle = cache(async (sessionId: string): Promise<string | null> => {
  try {
    const response = await fetch(`${API_URL}/live-session-titles/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { title?: string | null };
    return body.title?.trim() || null;
  } catch {
    return null;
  }
});

export async function sessionPageTitle(sessionId: string): Promise<string> {
  return (await fetchTitle(sessionId)) ?? FALLBACK;
}

/** The session a sign-in redirect leads to, so a link preview that lands on /login still shows its title. */
export function sessionIdFromNext(next: string | undefined): string | null {
  return next ? (SESSION_PATH.exec(next)?.[1] ?? null) : null;
}

import { writeAuthState } from "draft-core/auth-state";

export interface BrowserSignInEvents {
  openUrl(url: string): void;
  progress(value: { phase: "awaiting_approval" | "complete" | "error"; error?: string }): void;
}
export async function startBrowserSignIn(signal: AbortSignal, events: BrowserSignInEvents): Promise<void> {
  const apiUrl = process.env.DRAFT_API_BASE_URL ?? "https://api.draftai.us";
  const appUrl = process.env.DRAFT_APP_URL ?? "https://app.draftai.us";
  try {
    const created = await fetch(`${apiUrl}/link`, { method: "POST", signal });
    if (!created.ok) throw new Error("pairing_unavailable");
    const { code } = await created.json() as { code: string };
    events.openUrl(`${appUrl}/link?code=${encodeURIComponent(code)}`);
    events.progress({ phase: "awaiting_approval" });
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline && !signal.aborted) {
      await new Promise<void>((resolve, reject) => { const id = setTimeout(resolve, 2000); signal.addEventListener("abort", () => { clearTimeout(id); reject(new DOMException("Aborted", "AbortError")); }, { once: true }); });
      const response = await fetch(`${apiUrl}/link/${encodeURIComponent(code)}`, { signal });
      if (response.status === 204) continue;
      if (response.status === 404) throw new Error("expired");
      if (!response.ok) throw new Error("pairing_failed");
      const tokens = await response.json() as { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number };
      const nowSeconds = Math.floor(Date.now() / 1000);
      writeAuthState({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: tokens.expires_at ?? nowSeconds + (tokens.expires_in ?? 3600) });
      events.progress({ phase: "complete" }); return;
    }
    if (!signal.aborted) events.progress({ phase: "error", error: "timed_out" });
  } catch (error) {
    if (!signal.aborted) events.progress({ phase: "error", error: error instanceof Error ? error.message : "pairing_failed" });
  }
}

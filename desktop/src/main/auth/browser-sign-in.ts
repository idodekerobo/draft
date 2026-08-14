import { pairDevice, DevicePairingError } from "draft-core/device-pairing";
import { writeAuthState } from "draft-core/auth-state";

export interface BrowserSignInEvents {
  openUrl(url: string): void;
  progress(value: { phase: "awaiting_approval" | "complete" | "error"; error?: string }): void;
}

export async function startBrowserSignIn(signal: AbortSignal, events: BrowserSignInEvents): Promise<void> {
  const apiUrl = process.env.DRAFT_API_BASE_URL ?? "https://api.draftai.us";
  const appUrl = process.env.DRAFT_APP_URL ?? "https://app.draftai.us";

  let tokens;
  try {
    tokens = await pairDevice({
      apiUrl,
      appUrl,
      fetch,
      signal,
      onUrl: events.openUrl,
      // browser-sign-in only distinguishes "awaiting_approval" from
      // terminal outcomes — collapse the primitive's richer progress
      // events into the desktop UI's existing two-phase shape.
      onProgress: (event) => {
        if (event.phase === "awaiting_approval") events.progress({ phase: "awaiting_approval" });
      },
    });
  } catch (error) {
    if (signal.aborted) return;
    const message = error instanceof DevicePairingError ? error.kind : (error instanceof Error ? error.message : "pairing_failed");
    events.progress({ phase: "error", error: message === "timed_out" ? "timed_out" : message });
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const authState = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    organization_id: null,
    team_id: null,
    workspace_id: null,
    identity_resolved: false,
    onboarding_completed_at: null,
  };
  writeAuthState(authState);

  try {
    const whoamiResponse = await fetch(`${apiUrl}/whoami`, {
      signal,
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (whoamiResponse.ok) {
      const whoami = await whoamiResponse.json() as {
        organization_id: string | null;
        primary_team_id: string | null;
        workspace_id: string | null;
        onboarding_completed_at: string | null;
      };
      writeAuthState({
        ...authState,
        organization_id: whoami.organization_id,
        team_id: whoami.primary_team_id,
        workspace_id: whoami.workspace_id,
        identity_resolved: true,
        onboarding_completed_at: whoami.onboarding_completed_at ?? null,
      });
    }
  } catch { /* non-fatal — sign-in still completes with uncached identity */ }

  events.progress({ phase: "complete" });
}

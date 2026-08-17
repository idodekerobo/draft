// core/src/device-pairing.ts — shared device pairing primitive
//
// Used by: draft-desktop (browser-sign-in), draft-cli (auth login)
//
// Owns the full POST /link → poll GET /link/:code loop: creating a pairing
// code, emitting the pairing URL, polling until approved/expired/failed,
// and honoring cancellation. Token persistence and identity hydration are
// deliberately NOT part of this primitive — callers own their auth store
// and call their own whoami.

const POLL_INTERVAL_MS = 2_000;
const PAIRING_DEADLINE_MS = 300_000; // 5 minutes

export interface PairedTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export type DevicePairingProgress =
  | { phase: "awaiting_approval" }
  | { phase: "authenticated" }
  | { phase: "expired" }
  | { phase: "interrupted" }
  | { phase: "error"; error: string };

export interface DevicePairingDeps {
  apiUrl: string;
  appUrl: string;
  fetch: typeof fetch;
  signal: AbortSignal;
  onUrl(url: string): void;
  onProgress(event: DevicePairingProgress): void;
  /** Overridable for tests; defaults to POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
  /** Overridable for tests; defaults to PAIRING_DEADLINE_MS. */
  deadlineMs?: number;
  now?(): number;
}

export class DevicePairingError extends Error {
  constructor(public readonly kind: "expired" | "timed_out" | "pairing_failed" | "malformed_response" | "aborted") {
    super(kind);
    this.name = "DevicePairingError";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DevicePairingError("aborted")); return; }
    const id = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(id); reject(new DevicePairingError("aborted")); }, { once: true });
  });
}

/**
 * Runs the full pairing loop and resolves with fresh tokens once the user
 * approves the pairing in the browser. Rejects with DevicePairingError on
 * expiry, malformed responses, transient failure, timeout, or abort.
 */
export async function pairDevice(deps: DevicePairingDeps): Promise<PairedTokens> {
  const now = deps.now ?? (() => Date.now());
  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadlineMs = deps.deadlineMs ?? PAIRING_DEADLINE_MS;

  let created: Response;
  try {
    created = await deps.fetch(`${deps.apiUrl}/link`, { method: "POST", signal: deps.signal });
  } catch (error) {
    if (deps.signal.aborted) throw new DevicePairingError("aborted");
    throw new DevicePairingError("pairing_failed");
  }
  if (!created.ok) throw new DevicePairingError("pairing_failed");

  let code: string;
  try {
    const body = await created.json() as { code?: unknown };
    if (typeof body.code !== "string" || !body.code) throw new DevicePairingError("malformed_response");
    code = body.code;
  } catch (error) {
    if (error instanceof DevicePairingError) throw error;
    throw new DevicePairingError("malformed_response");
  }

  deps.onUrl(`${deps.appUrl}/link?code=${encodeURIComponent(code)}`);
  deps.onProgress({ phase: "awaiting_approval" });

  const deadline = now() + deadlineMs;
  while (now() < deadline) {
    try {
      await sleep(pollIntervalMs, deps.signal);
    } catch {
      deps.onProgress({ phase: "interrupted" });
      throw new DevicePairingError("aborted");
    }

    let response: Response;
    try {
      response = await deps.fetch(`${deps.apiUrl}/link/${encodeURIComponent(code)}`, { signal: deps.signal });
    } catch {
      if (deps.signal.aborted) { deps.onProgress({ phase: "interrupted" }); throw new DevicePairingError("aborted"); }
      throw new DevicePairingError("pairing_failed");
    }

    if (response.status === 204) continue;
    if (response.status === 404) { deps.onProgress({ phase: "expired" }); throw new DevicePairingError("expired"); }
    if (!response.ok) throw new DevicePairingError("pairing_failed");

    const tokens = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_at?: unknown; expires_in?: unknown };
    if (typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") {
      throw new DevicePairingError("malformed_response");
    }
    const nowSeconds = Math.floor(now() / 1000);
    const expiresAt = typeof tokens.expires_at === "number"
      ? tokens.expires_at
      : nowSeconds + (typeof tokens.expires_in === "number" ? tokens.expires_in : 3600);

    deps.onProgress({ phase: "authenticated" });
    return { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: expiresAt };
  }

  deps.onProgress({ phase: "expired" });
  throw new DevicePairingError("timed_out");
}

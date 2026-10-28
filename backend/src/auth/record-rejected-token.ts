import { recordError, type RecordErrorInput } from "../errors/record-error";
import { allowOncePer } from "../errors/throttle";

const WINDOW_MS = 60_000;

/** Records a rejected login. Skips malformed tokens and provider outages: neither is a dead login. */
export function recordRejectedToken(
  accessToken: string,
  error: { code?: string; status?: number } | null,
  record: (input: RecordErrorInput) => Promise<void> = recordError,
): void {
  if (accessToken.split(".").length !== 3) return;
  const status = error?.status;
  if (!status || status >= 500) return;
  const code = error.code ?? `status_${status}`;
  if (!allowOncePer(`token_rejected:${code}`, WINDOW_MS)) return;
  void record({ workspaceId: null, allowUnattributed: true, operation: "auth", message: "login rejected by auth provider", code, detail: { status } });
}

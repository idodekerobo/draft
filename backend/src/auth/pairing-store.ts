import { generatePairingCode } from "./generate-token";

export interface PairingTokens {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
}
interface PendingPairing { createdAt: number; tokens?: PairingTokens }
const TTL_MS = 5 * 60 * 1000;
let now = () => Date.now();
let pending = new Map<string, PendingPairing>();

// Intentionally process-local for only one long lived server. Replace with shared storage/redis before scaling horizontally.
export function createPairing(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generatePairingCode();
    if (!pending.has(code)) { pending.set(code, { createdAt: now() }); return code; }
  }
  throw new Error("unable_to_allocate_pairing_code");
}
export function approvePairing(code: string, tokens: PairingTokens): boolean {
  const entry = pending.get(code);
  if (!entry || now() - entry.createdAt >= TTL_MS || entry.tokens) { pending.delete(code); return false; }
  entry.tokens = tokens;
  return true;
}
export function consumePairing(code: string): "pending" | "expired_or_unknown" | PairingTokens {
  const entry = pending.get(code);
  if (!entry || now() - entry.createdAt >= TTL_MS) { pending.delete(code); return "expired_or_unknown"; }
  if (!entry.tokens) return "pending";
  pending.delete(code);
  return entry.tokens;
}
export function resetPairingStore(clock: () => number = () => Date.now()): void {
  pending = new Map(); now = clock;
}

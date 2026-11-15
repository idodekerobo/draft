import { timingSafeEqual } from "node:crypto";
import { generatePairingCode } from "./generate-token";

export interface PairingTokens {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
}
interface PendingPairing {
  createdAt: number;
  tokens?: PairingTokens;
  /** Shown by the client that asked; the person types it to approve, so they can't approve someone else's sign-in. */
  confirmCode: string;
  client: string | null;
  wrongAttempts: number;
}
const TTL_MS = 5 * 60 * 1000;
const MAX_WRONG_ATTEMPTS = 5;
let now = () => Date.now();
let pending = new Map<string, PendingPairing>();

const normalize = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");
const sameCode = (a: string, b: string) => {
  const left = Buffer.from(normalize(a));
  const right = Buffer.from(normalize(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

// Intentionally process-local for only one long lived server. Replace with shared storage/redis before scaling horizontally.
export function createPairing(options: { client?: string | null } = {}): { code: string; confirmCode: string } {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generatePairingCode();
    if (pending.has(code)) continue;
    const confirmCode = generatePairingCode(6);
    pending.set(code, { createdAt: now(), confirmCode, client: options.client ?? null, wrongAttempts: 0 });
    return { code, confirmCode };
  }
  throw new Error("unable_to_allocate_pairing_code");
}

/** What the approval page shows about the sign-in it is approving. */
export function pairingInfo(code: string): { client: string | null; requestedAt: string } | null {
  const entry = pending.get(code);
  if (!entry || now() - entry.createdAt >= TTL_MS || entry.tokens) return null;
  return { client: entry.client, requestedAt: new Date(entry.createdAt).toISOString() };
}

/** Checks the code the person typed. A wrong code counts against the sign-in; after five it is dropped, so the code can't be guessed. */
export function checkPairingConfirm(code: string, confirmCode: string | undefined): "ok" | "wrong_code" | "expired_or_unknown" {
  const entry = pending.get(code);
  if (!entry || now() - entry.createdAt >= TTL_MS || entry.tokens) { pending.delete(code); return "expired_or_unknown"; }
  if (confirmCode && sameCode(confirmCode, entry.confirmCode)) return "ok";
  entry.wrongAttempts += 1;
  if (entry.wrongAttempts >= MAX_WRONG_ATTEMPTS) pending.delete(code);
  return "wrong_code";
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

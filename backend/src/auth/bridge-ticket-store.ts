import { randomBytes } from "node:crypto";

interface PendingTicket {
  userId: string;
  createdAt: number;
}

const TTL_MS = 60 * 1000;
let now = () => Date.now();
let pending = new Map<string, PendingTicket>();

/** One-time, 60s-lived ticket binding a verified userId to an opaque value, so it can travel in a URL without exposing the Supabase token itself. */
export function createBridgeTicket(userId: string): string {
  const ticket = randomBytes(24).toString("base64url");
  pending.set(ticket, { userId, createdAt: now() });
  return ticket;
}

export function consumeBridgeTicket(ticket: string): string | null {
  const entry = pending.get(ticket);
  pending.delete(ticket);
  if (!entry || now() - entry.createdAt >= TTL_MS) return null;
  return entry.userId;
}

export function resetBridgeTicketStore(clock: () => number = () => Date.now()): void {
  pending = new Map();
  now = clock;
}

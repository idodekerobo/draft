import { randomBytes, randomInt } from "node:crypto";

export function generateInviteToken(): string {
  return randomBytes(24).toString("base64url");
}

const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generatePairingCode(length = 8): string {
  return Array.from({ length }, () =>
    PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)],
  ).join("");
}

import { describe, expect, it } from "bun:test";
import { generateInviteToken, generatePairingCode } from "../../auth/generate-token";
describe("auth token generation", () => {
  it("creates URL-safe, distinct invite tokens", () => { const a=generateInviteToken(),b=generateInviteToken(); expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/); expect(a).not.toBe(b); });
  it("creates unambiguous pairing codes", () => expect(generatePairingCode()).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/));
});

import { beforeEach, describe, expect, it } from "bun:test";
import { approvePairing, consumePairing, createPairing, resetPairingStore } from "../../auth/pairing-store";

describe("pairing store", () => {
  let time = 1000;
  beforeEach(() => { time = 1000; resetPairingStore(() => time); });
  it("approves and consumes token pairs exactly once", () => {
    const code = createPairing();
    expect(consumePairing(code)).toBe("pending");
    expect(approvePairing(code, { access_token: "access", refresh_token: "refresh", expires_at: 99 })).toBe(true);
    expect(consumePairing(code)).toEqual({ access_token: "access", refresh_token: "refresh", expires_at: 99 });
    expect(consumePairing(code)).toBe("expired_or_unknown");
  });
  it("expires entries and rejects late approval", () => {
    const code = createPairing(); time += 300_000;
    expect(approvePairing(code, { access_token: "a", refresh_token: "r" })).toBe(false);
    expect(consumePairing(code)).toBe("expired_or_unknown");
  });
});

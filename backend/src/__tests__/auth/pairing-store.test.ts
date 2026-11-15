import { beforeEach, describe, expect, it } from "bun:test";
import { approvePairing, checkPairingConfirm, consumePairing, createPairing, pairingInfo, resetPairingStore } from "../../auth/pairing-store";

describe("pairing store", () => {
  let time = 1000;
  beforeEach(() => { time = 1000; resetPairingStore(() => time); });
  it("approves and consumes token pairs exactly once", () => {
    const { code } = createPairing();
    expect(consumePairing(code)).toBe("pending");
    expect(approvePairing(code, { access_token: "access", refresh_token: "refresh", expires_at: 99 })).toBe(true);
    expect(consumePairing(code)).toEqual({ access_token: "access", refresh_token: "refresh", expires_at: 99 });
    expect(consumePairing(code)).toBe("expired_or_unknown");
  });
  it("expires entries and rejects late approval", () => {
    const { code } = createPairing(); time += 300_000;
    expect(approvePairing(code, { access_token: "a", refresh_token: "r" })).toBe(false);
    expect(consumePairing(code)).toBe("expired_or_unknown");
  });
});

describe("pairing confirmation code", () => {
  beforeEach(() => resetPairingStore(() => 1000));
  it("approves only with the code, typed in any case or with a dash", () => {
    const { code, confirmCode } = createPairing({ client: "Draft CLI" });
    expect(checkPairingConfirm(code, undefined)).toBe("wrong_code");
    expect(checkPairingConfirm(code, "ZZZZZZ")).toBe("wrong_code");
    expect(checkPairingConfirm(code, `${confirmCode.slice(0, 3).toLowerCase()}-${confirmCode.slice(3)}`)).toBe("ok");
  });
  it("drops the sign-in after five wrong codes, so the code can't be guessed", () => {
    const { code, confirmCode } = createPairing();
    for (let attempt = 0; attempt < 5; attempt++) checkPairingConfirm(code, "WRONG1");
    expect(checkPairingConfirm(code, confirmCode)).toBe("expired_or_unknown");
  });
  it("tells the approval page which app asked, and when", () => {
    const { code } = createPairing({ client: "Draft CLI 0.10.5" });
    expect(pairingInfo(code)).toEqual({ client: "Draft CLI 0.10.5", requestedAt: new Date(1000).toISOString() });
  });
});

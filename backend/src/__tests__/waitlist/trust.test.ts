import { describe, expect, it } from "bun:test";
import { isTrustedLandingRequest, LANDING_SECRET_HEADER } from "../../waitlist/trust";

function request(secret?: string) {
  return new Request("http://localhost/waitlist", {
    method: "POST",
    headers: secret === undefined ? {} : { [LANDING_SECRET_HEADER]: secret },
  });
}

describe("isTrustedLandingRequest", () => {
  it("accepts a matching secret", () => {
    expect(isTrustedLandingRequest(request("abc123"), "abc123")).toBe(true);
  });

  it("rejects a wrong or missing header", () => {
    expect(isTrustedLandingRequest(request("abc124"), "abc123")).toBe(false);
    expect(isTrustedLandingRequest(request("short"), "abc123")).toBe(false);
    expect(isTrustedLandingRequest(request(), "abc123")).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    expect(isTrustedLandingRequest(request("abc123"), undefined)).toBe(false);
    expect(isTrustedLandingRequest(request(""), "")).toBe(false);
  });
});

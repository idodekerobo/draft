import { describe, expect, it } from "bun:test";
import { emailStatusFromResend, mergeEmailStatus } from "../../notify/email-status";

describe("emailStatusFromResend", () => {
  it("maps Resend events to Draft statuses", () => {
    expect(emailStatusFromResend("delivered")).toBe("delivered");
    expect(emailStatusFromResend("delivery_delayed")).toBe("delayed");
    expect(emailStatusFromResend("bounced")).toBe("bounced");
    expect(emailStatusFromResend("complained")).toBe("complained");
    expect(emailStatusFromResend("suppressed")).toBe("failed");
    expect(emailStatusFromResend("opened")).toBe("delivered");
  });
  it("treats sent, unknown and missing events as accepted", () => {
    expect(emailStatusFromResend("sent")).toBe("accepted");
    expect(emailStatusFromResend("something_new")).toBe("accepted");
    expect(emailStatusFromResend(null)).toBe("accepted");
  });
});

describe("mergeEmailStatus", () => {
  it("moves forward", () => {
    expect(mergeEmailStatus("accepted", "delivered")).toBe("delivered");
    expect(mergeEmailStatus("delivered", "complained")).toBe("complained");
  });
  it("never moves back", () => {
    expect(mergeEmailStatus("delivered", "accepted")).toBe("delivered");
    expect(mergeEmailStatus("bounced", "delivered")).toBe("bounced");
    expect(mergeEmailStatus("delivered", "delayed")).toBe("delivered");
  });
  it("keeps the first of two final statuses", () => {
    expect(mergeEmailStatus("bounced", "complained")).toBe("bounced");
  });
});

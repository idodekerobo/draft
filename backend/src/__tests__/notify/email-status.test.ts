import { describe, expect, it } from "bun:test";
import { emailStatusFromResend, mergeEmailStatus } from "../../notify/channels/email/status";

describe("emailStatusFromResend", () => {
  it("maps Resend events to Draft statuses", () => {
    expect(emailStatusFromResend("delivered")).toBe("delivered");
    expect(emailStatusFromResend("delivery_delayed")).toBe("delayed");
    expect(emailStatusFromResend("bounced")).toBe("bounced");
    expect(emailStatusFromResend("complained")).toBe("complained");
    expect(emailStatusFromResend("suppressed")).toBe("failed");
    expect(emailStatusFromResend("opened")).toBe("delivered");
  });
  it("treats sent, unknown and missing events as sent", () => {
    expect(emailStatusFromResend("sent")).toBe("sent");
    expect(emailStatusFromResend("something_new")).toBe("sent");
    expect(emailStatusFromResend(null)).toBe("sent");
  });
});

describe("mergeEmailStatus", () => {
  it("moves forward", () => {
    expect(mergeEmailStatus("sent", "delivered")).toBe("delivered");
    expect(mergeEmailStatus("delivered", "complained")).toBe("complained");
  });
  it("moves a queued delivery forward once the provider has an event", () => {
    expect(mergeEmailStatus("queued", "sent")).toBe("sent");
  });
  it("never moves back", () => {
    expect(mergeEmailStatus("delivered", "sent")).toBe("delivered");
    expect(mergeEmailStatus("bounced", "delivered")).toBe("bounced");
    expect(mergeEmailStatus("delivered", "delayed")).toBe("delivered");
  });
  it("keeps the first of two final statuses", () => {
    expect(mergeEmailStatus("bounced", "complained")).toBe("bounced");
  });
});

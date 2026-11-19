import { describe, expect, it } from "bun:test";
import { closedMessage, toApprovalResult } from "./approval-result";

describe("toApprovalResult", () => {
  it("keeps a sleeping session apart from a request that ended, so the panel says why", () => {
    const result = toApprovalResult("session_sleeping");
    expect(result).toEqual({ ok: false, error: "session_sleeping" });
    expect(closedMessage(result)).toBe("This session is asleep");
  });

  it("still reports an unknown code as a failed decision", () => {
    expect(toApprovalResult("something_new")).toEqual({ ok: false, error: "failed" });
  });
});

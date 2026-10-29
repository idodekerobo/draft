import { describe, expect, it } from "bun:test";
import { COMMAND_APPROVAL, FILE_CHANGE_APPROVAL, approvalDecision, approvalPayload } from "./approvals";

describe("approvalPayload", () => {
  it("shows the command and where it runs", () => {
    expect(approvalPayload(COMMAND_APPROVAL, { command: "touch a", cwd: "/p", reason: "May I?" })).toEqual({
      tool_name: "command",
      tool_input: { command: "touch a", cwd: "/p", reason: "May I?" },
    });
  });

  it("shows a file change by its reason", () => {
    expect(approvalPayload(FILE_CHANGE_APPROVAL, { reason: "write", grantRoot: "/p" })?.tool_name).toBe("file_change");
  });

  it("is null for requests that are not approvals", () => {
    expect(approvalPayload("item/tool/requestUserInput", {})).toBeNull();
  });
});

describe("approvalDecision", () => {
  it("maps allow, deny and no answer", () => {
    expect(approvalDecision({ behavior: "allow" })).toBe("accept");
    expect(approvalDecision({ behavior: "deny" })).toBe("decline");
    expect(approvalDecision(null)).toBe("cancel");
  });
});

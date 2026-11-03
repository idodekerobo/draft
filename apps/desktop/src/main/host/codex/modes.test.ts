import { describe, expect, it } from "bun:test";
import { approvalOverrides, collaborationUpdate, isApproval, isCollaboration } from "./modes";

describe("codex modes", () => {
  it("maps each approval choice to turn settings", () => {
    expect(approvalOverrides("ask-for-approval")).toEqual({ approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" } });
    expect(approvalOverrides("approve-for-me")).toMatchObject({ approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
    expect(approvalOverrides("full-access")).toEqual({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  });

  it("builds the collaboration update with the thread's model and no instruction change", () => {
    expect(collaborationUpdate("t1", "plan", "gpt-6-luna")).toEqual({
      threadId: "t1",
      collaborationMode: { mode: "plan", settings: { model: "gpt-6-luna", reasoning_effort: null, developer_instructions: null } },
    });
  });

  it("recognises only known values", () => {
    expect(isApproval("full-access") && isCollaboration("plan")).toBe(true);
    expect(isApproval("yolo") || isCollaboration("auto") || isApproval(undefined)).toBe(false);
  });
});

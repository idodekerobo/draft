import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlanCard } from "./PlanCard";
import type { OpenApproval } from "./stream-items";
import type { ApprovalResponse, ApprovalResult } from "./types";

afterEach(cleanup);

const plan = (permissionMode: string | null = "plan"): OpenApproval => ({
  type: "approval", seq: 1, requestId: "r1", kind: "plan", tool: "ExitPlanMode", summary: "", input: {}, questions: [], plan: "# Plan\n\n1. Write hello.txt\n2. Read it back", allowSession: false, permissionMode, resolved: null,
});

function setup(approval = plan(), result: ApprovalResult = { ok: true }) {
  const onDecide = mock(async (_id: string, _response: ApprovalResponse) => result);
  render(<PlanCard approval={approval} hostName="Maya's MacBook" onDecide={onDecide} />);
  return onDecide;
}

describe("PlanCard", () => {
  it("shows the plan as formatted text with Claude's three choices", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByText("Write hello.txt")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes, and use auto mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes, manually approve edits" })).toBeTruthy();
    expect(screen.getByText("Tell Claude what to change")).toBeTruthy();
  });

  it("approves into auto mode or into manual edits", async () => {
    const onDecide = setup();
    fireEvent.click(screen.getByRole("button", { name: "Yes, and use auto mode" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("r1", { decision: "allow", permissionMode: "auto" }));
    cleanup();
    const second = setup();
    fireEvent.click(screen.getByRole("button", { name: "Yes, manually approve edits" }));
    await waitFor(() => expect(second).toHaveBeenCalledWith("r1", { decision: "allow", permissionMode: "default" }));
    await screen.findByText(/Waiting for Maya's MacBook/);
  });

  it("sends the typed changes as a denial, and only when something is typed", async () => {
    const onDecide = setup();
    const send = screen.getByRole("button", { name: "Send changes" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  make it 2 steps  " } });
    fireEvent.click(send);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("r1", { decision: "deny", message: "make it 2 steps" }));
  });

  it("hides the auto choice when the session is already in auto mode", () => {
    setup(plan("auto"));
    expect(screen.queryByRole("button", { name: "Yes, and use auto mode" })).toBeNull();
    expect(screen.getByRole("button", { name: "Yes, manually approve edits" })).toBeTruthy();
  });

  it("says who got there first and removes the choices", async () => {
    setup(plan(), { ok: false, error: "already_decided", byName: "Dev" });
    fireEvent.click(screen.getByRole("button", { name: "Yes, manually approve edits" }));
    await screen.findByText("Already decided by Dev");
    expect(screen.queryByRole("button", { name: "Send changes" })).toBeNull();
  });
});

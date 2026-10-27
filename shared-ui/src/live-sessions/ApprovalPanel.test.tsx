import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApprovalPanel } from "./ApprovalPanel";
import type { OpenApproval } from "./stream-items";
import type { ApprovalResult } from "./types";

afterEach(cleanup);

const approval = (input: unknown = { file_path: "/a/hello.txt", content: "hi" }): OpenApproval => ({
  type: "approval", seq: 1, requestId: "r1", tool: "Write", summary: "/a/hello.txt", input, resolved: null,
});

function renderPanel(result: ApprovalResult = { ok: true }, props: Partial<Parameters<typeof ApprovalPanel>[0]> = {}) {
  const onDecide = mock(async (_id: string, _decision: "allow" | "deny") => result);
  render(<ApprovalPanel approval={approval()} hostName="Maya's MacBook" onDecide={onDecide} {...props} />);
  return onDecide;
}

describe("ApprovalPanel", () => {
  it("names the tool and where it runs, and shows the input", () => {
    renderPanel();
    expect(screen.getByRole("group", { name: "Permission request: Write" })).toBeTruthy();
    expect(screen.getByText("Runs on Maya's MacBook")).toBeTruthy();
    expect(screen.getByText(/hello\.txt/, { selector: "pre" })).toBeTruthy();
  });

  it("Allow sends the decision and then waits for the host", async () => {
    const onDecide = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("r1", "allow"));
    await screen.findByText(/Waiting for Maya's MacBook/);
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Deny sends deny", async () => {
    const onDecide = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("r1", "deny"));
  });

  it("a late decider sees who decided and loses the buttons", async () => {
    renderPanel({ ok: false, error: "already_decided", byName: "Dev" });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await screen.findByText("Already decided by Dev");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("says when the request ended another way", async () => {
    renderPanel({ ok: false, error: "request_closed" });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await screen.findByText("This request already ended");
  });

  it("keeps the buttons and shows an error near them when sending fails", async () => {
    renderPanel({ ok: false, error: "failed" });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await screen.findByText("Could not send. Try again.");
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("cuts a long input to three lines until Show all", () => {
    const long = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
    render(<ApprovalPanel approval={approval(long)} hostName={null} onDecide={async () => ({ ok: true })} />);
    expect(screen.queryByText(/line 7/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByText(/line 7/)).toBeTruthy();
    expect(screen.getByText("Runs on the owner's computer")).toBeTruthy();
  });
});

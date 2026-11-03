import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApprovalPanel } from "./ApprovalPanel";
import type { OpenApproval } from "./stream-items";
import type { ApprovalResponse, ApprovalResult } from "./types";

afterEach(cleanup);

const approval = (input: unknown = { file_path: "/a/hello.txt", content: "hi" }): OpenApproval => ({
  type: "approval", seq: 1, requestId: "r1", kind: "approval", tool: "Write", summary: "/a/hello.txt", input, questions: [], plan: null, allowSession: false, permissionMode: null, resolved: null,
});

function renderPanel(result: ApprovalResult = { ok: true }, props: Partial<Parameters<typeof ApprovalPanel>[0]> = {}) {
  const onDecide = mock(async (_id: string, _response: ApprovalResponse) => result);
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
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("r1", { decision: "allow" }));
    await screen.findByText(/Waiting for Maya's MacBook/);
    expect((screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Deny opens a reason box, and a second click sends deny without a reason when it is empty", async () => {
    const onDecide = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    expect(screen.getByText("Tell Claude why (optional)")).toBeTruthy();
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("r1", { decision: "deny" }));
  });

  it("Deny sends the typed reason as the message", async () => {
    const onDecide = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  use a temp dir  " } });
    fireEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("r1", { decision: "deny", message: "use a temp dir" }));
  });

  it("Allow ignores a reason that was typed", async () => {
    const onDecide = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "no" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("r1", { decision: "allow" }));
  });

  it("a late decider sees who decided and loses the buttons", async () => {
    renderPanel({ ok: false, error: "already_decided", byName: "Dev" });
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await screen.findByText("Already decided by Dev");
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("says when the request ended another way", async () => {
    renderPanel({ ok: false, error: "request_closed" });
    fireEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Deny/ }));
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

  it("offers Allow for session only when the harness can, and sends the scope", async () => {
    const onDecide = mock(async (_id: string, _response: ApprovalResponse) => ({ ok: true as const }));
    const view = render(<ApprovalPanel approval={approval()} hostName={null} onDecide={onDecide} />);
    expect(screen.queryByRole("button", { name: "Allow for session" })).toBeNull();
    view.unmount();
    render(<ApprovalPanel approval={{ ...approval(), allowSession: true }} hostName={null} onDecide={onDecide} agent="Codex" explainsDenial={false} />);
    expect(screen.getByText("Codex wants to use")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow for session" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("r1", { decision: "allow", scope: "session" }));
  });

  it("denies at once, with no reason box, when the agent cannot read a reason", async () => {
    const onDecide = mock(async (_id: string, _response: ApprovalResponse) => ({ ok: true as const }));
    render(<ApprovalPanel approval={approval()} hostName={null} onDecide={onDecide} agent="Codex" explainsDenial={false} />);
    fireEvent.click(screen.getByRole("button", { name: /^Deny/ }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("r1", { decision: "deny" }));
    expect(screen.queryByText(/why/i)).toBeNull();
  });
});

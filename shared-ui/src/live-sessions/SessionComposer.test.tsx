import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionComposer } from "./SessionComposer";
import type { LiveSessionInput } from "./types";

afterEach(cleanup);

const input = (patch: Partial<LiveSessionInput>): LiveSessionInput => ({
  id: "i1", author_user_id: "u1", author_name: "Priya", text: "run the tests", state: "queued", reason: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), mine: true, ...patch,
});

function renderComposer(props: Partial<Parameters<typeof SessionComposer>[0]> = {}) {
  const send = mock(async (_text: string) => {});
  const act = mock(async (_id: string, _action: "resend" | "dismiss") => {});
  render(<SessionComposer inputs={[]} send={send} act={act} ownerName="Maya" ended={false} {...props} />);
  return { send, act };
}

describe("SessionComposer", () => {
  it("sends the message on Enter and clears the box", async () => {
    const { send } = renderComposer();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "  please add tests  " } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledWith("please add tests"));
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("Shift+Enter does not send", () => {
    const { send } = renderComposer();
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "line" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the text and shows the reason when sending fails", async () => {
    const { send } = renderComposer();
    send.mockImplementation(async () => {
      throw new Error("queue_full");
    });
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Too many messages are waiting. Try again soon.");
    expect(box.value).toBe("hello");
  });

  it("shows the state line of a waiting message", () => {
    renderComposer({ inputs: [input({ reason: "composer_busy" })] });
    expect(screen.getByText("Queued, Maya is typing in the terminal")).toBeTruthy();
  });

  it("offers Resend for the sender's uncertain message only", async () => {
    const { act } = renderComposer({ inputs: [input({ state: "uncertain" }), input({ id: "i2", mine: false, state: "uncertain", author_name: "Dev" })] });
    expect(screen.getAllByText("May not have been delivered.").length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Resend" }).length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Resend" }));
    expect(act).toHaveBeenCalledWith("i1", "resend");
  });

  it("replaces the box when the session has ended", () => {
    renderComposer({ ended: true });
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

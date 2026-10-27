import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionStartScreen } from "./SessionStartScreen";

afterEach(cleanup);

function setup(recent: string[] = ["/work/marigold", "/work/other"]) {
  const onStart = mock(async (_request: { folderPath: string; text: string; model: string | null }) => ({ ok: true }) as { ok: true } | { ok: false; error: string });
  const onBrowse = mock(async () => "/picked/project" as string | null);
  render(<SessionStartScreen recentFolders={recent} onBrowse={onBrowse} onStart={onStart} />);
  return { onStart, onBrowse };
}

describe("SessionStartScreen", () => {
  it("focuses the message box and defaults to the last folder", () => {
    setup();
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    expect(screen.getByRole("button", { name: /marigold/ })).toBeTruthy();
  });

  it("starts in the default folder with the typed text", async () => {
    const { onStart } = setup();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  fix the login bug  " } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ folderPath: "/work/marigold", text: "fix the login bug", model: null }));
  });

  it("starts in a recent folder picked from the menu", async () => {
    const { onStart } = setup();
    fireEvent.click(screen.getByRole("button", { name: /marigold/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /other/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ folderPath: "/work/other", text: "go", model: null }));
  });

  it("starts in a folder found with Browse", async () => {
    const { onStart, onBrowse } = setup();
    fireEvent.click(screen.getByRole("button", { name: /marigold/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Browse…" }));
    await screen.findByRole("button", { name: /project/ });
    expect(onBrowse).toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ folderPath: "/picked/project", text: "go", model: null }));
  });

  it("asks for a folder when there is no recent one and blocks Start", () => {
    setup([]);
    expect(screen.getByText("Choose a folder to start in.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the error and keeps the text when starting fails", async () => {
    const { onStart } = setup();
    onStart.mockImplementation(async () => ({ ok: false, error: "Claude Code is not installed on this computer." }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await screen.findByText("Claude Code is not installed on this computer.");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("hello");
  });

  it("offers Claude Code as the only agent and Default first in the model list", () => {
    setup();
    const agent = screen.getByLabelText("Agent") as HTMLSelectElement;
    expect(Array.from(agent.options).map((o) => o.text)).toEqual(["Claude Code"]);
    const model = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(Array.from(model.options).map((o) => o.text)).toEqual(["Default", "Fable", "Opus", "Sonnet", "Haiku"]);
    expect(model.value).toBe("");
  });

  it("starts with the chosen model alias", async () => {
    const { onStart } = setup();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "sonnet" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ folderPath: "/work/marigold", text: "go", model: "sonnet" }));
  });
});

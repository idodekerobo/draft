import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionStartScreen } from "./SessionStartScreen";

afterEach(cleanup);

function setup(recent: string[] = ["/work/marigold", "/work/other"]) {
  const onStart = mock(async (_request: { harness: string; folderPath: string; text: string; model: string | null }) => ({ ok: true }) as { ok: true } | { ok: false; error: string });
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
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "claude", folderPath: "/work/marigold", text: "fix the login bug", model: null }));
  });

  it("starts in a recent folder picked from the menu", async () => {
    const { onStart } = setup();
    fireEvent.click(screen.getByRole("button", { name: /marigold/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /other/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "claude", folderPath: "/work/other", text: "go", model: null }));
  });

  it("starts in a folder found with Browse", async () => {
    const { onStart, onBrowse } = setup();
    fireEvent.click(screen.getByRole("button", { name: /marigold/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Browse…" }));
    await screen.findByRole("button", { name: /project/ });
    expect(onBrowse).toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "claude", folderPath: "/picked/project", text: "go", model: null }));
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

  it("keeps the folder bar and puts one picker next to Start, listing the harnesses and the models of the chosen one", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent?.replace("✓", ""))).toEqual(["Claude Code", "Codex", "Default", "Fable", "Opus", "Sonnet", "Haiku"]);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows the Codex models and starts with Codex and the chosen model", async () => {
    const { onStart } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Codex" }));
    expect(screen.queryByRole("menuitemradio", { name: "Opus" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GPT-6-Luna" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "codex", folderPath: "/work/marigold", text: "go", model: "gpt-6-luna" }));
  });

  it("marks a harness that is not installed or signed out, and blocks Start for it", () => {
    const { onStart } = setup();
    cleanup();
    render(<SessionStartScreen recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={onStart} availability={{ codex: "missing" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    expect(screen.getByRole("menuitemradio", { name: /Codex/ }).textContent).toContain("Install");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Codex is not installed on this computer.")).toBeTruthy();
  });

  it("only warns for an untested version", () => {
    const { onStart } = setup();
    cleanup();
    render(<SessionStartScreen recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={onStart} availability={{ claude: "untested_version" }} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("Some things may not work");
  });

  it("starts with the chosen model alias", async () => {
    const { onStart } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Sonnet" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "claude", folderPath: "/work/marigold", text: "go", model: "sonnet" }));
  });

  it("keeps the typed text when the screen remounts, and clears it after a start", async () => {
    const first = setup();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "unfinished idea" } });
    cleanup();
    const { onStart } = setup();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("unfinished idea");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await waitFor(() => expect(onStart).toHaveBeenCalled());
    cleanup();
    setup();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    void first;
  });
});

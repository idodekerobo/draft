import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionStartScreen, type StartRequest } from "./SessionStartScreen";

afterEach(cleanup);

function setup(recent: string[] = ["/work/marigold", "/work/other"]) {
  const onStart = mock(async (_request: StartRequest) => ({ ok: true }) as { ok: true } | { ok: false; error: string });
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
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "claude", folderPath: "/work/marigold", text: "fix the login bug", model: null, effort: null }));
  });

  it("starts in a recent folder picked from the menu", async () => {
    const { onStart } = setup();
    fireEvent.click(screen.getByRole("button", { name: /marigold/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /other/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "claude", folderPath: "/work/other", text: "go", model: null, effort: null }));
  });

  it("starts in a folder found with Browse", async () => {
    const { onStart, onBrowse } = setup();
    fireEvent.click(screen.getByRole("button", { name: /marigold/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Browse…" }));
    await screen.findByRole("button", { name: /project/ });
    expect(onBrowse).toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "claude", folderPath: "/picked/project", text: "go", model: null, effort: null }));
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
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent?.replace("✓", ""))).toEqual(["Claude Code", "Codex", "Default", "Fable", "Opus", "Sonnet", "Haiku", "Default", "Low", "Medium", "High", "Extra high", "Max"]);
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
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "codex", folderPath: "/work/marigold", text: "go", model: "gpt-6-luna", effort: null }));
  });

  it("keeps the picker open for harness and model, closes it on an effort, and lists only the efforts the model accepts", async () => {
    const { onStart } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Codex" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GPT-6-Sol" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Ultra" }));
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GPT-6-Luna" }));
    expect(screen.queryByRole("menuitemradio", { name: "Ultra" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Extra high" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "codex", folderPath: "/work/marigold", text: "go", model: "gpt-6-luna", effort: "xhigh" }));
  });

  it("falls back to the new model's default effort when the chosen effort is not offered", async () => {
    const { onStart } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Codex" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GPT-6-Sol" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Ultra" }));
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GPT-6-Luna" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "codex", folderPath: "/work/marigold", text: "go", model: "gpt-6-luna", effort: "medium" }));
  });

  it("shows what Default means on this computer, in the button and in the lists", async () => {
    const agentDefaults = mock(async (_harness: string) => ({ modelLabel: "Sonnet 5.5", effort: "low" }));
    render(<SessionStartScreen recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={async () => ({ ok: true })} agentDefaults={agentDefaults} />);
    const trigger = screen.getByRole("button", { name: "Agent and model" });
    await waitFor(() => expect(trigger.textContent).toContain("Claude Code · Sonnet 5.5 · Low"));
    fireEvent.click(trigger);
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent?.replace("✓", ""))).toContain("DefaultSonnet 5.5");
    expect(agentDefaults).toHaveBeenCalledWith("claude");
  });

  it("marks a harness that is not installed or signed out, and blocks Start for it", () => {
    const { onStart } = setup();
    cleanup();
    render(<SessionStartScreen recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={onStart} availability={{ codex: "missing" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    expect(screen.getByRole("menuitemradio", { name: /Codex/ }).textContent).toContain("Set up");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Codex is not installed on this computer.")).toBeTruthy();
  });

  it("shows the setup help in place of the problem line while the chosen harness blocks Start", () => {
    const { onStart } = setup();
    cleanup();
    const renderSetup = (harness: string) => (harness === "codex" ? <p>Set up Codex here</p> : null);
    render(<SessionStartScreen recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={onStart} availability={{ codex: "signed_out", claude: "missing" }} renderSetup={renderSetup} />);
    expect(screen.queryByText("Set up Codex here")).toBeNull();
    expect(screen.getByText("Claude Code is not installed on this computer.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex/ }));
    expect(screen.getByText("Set up Codex here")).toBeTruthy();
    expect(screen.queryByText(/is not signed in/)).toBeNull();
  });

  it("drops the setup help once the harness is ready, and Start turns on", () => {
    const { onStart } = setup();
    cleanup();
    const renderSetup = () => <p>Set up Codex here</p>;
    const view = render(<SessionStartScreen recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={onStart} availability={{ codex: "signed_out" }} renderSetup={renderSetup} />);
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<SessionStartScreen recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={onStart} availability={{}} renderSetup={renderSetup} />);
    expect(screen.queryByText("Set up Codex here")).toBeNull();
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("only warns for an untested version", () => {
    const { onStart } = setup();
    cleanup();
    render(<SessionStartScreen devOnly recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={onStart} availability={{ claude: "untested_version" }} />);
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
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "claude", folderPath: "/work/marigold", text: "go", model: "sonnet", effort: null }));
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

describe("SessionStartScreen in Draft cloud", () => {
  const REMOTE = "https://github.com/acme/marigold";
  const cloudSetup = ({ remote = REMOTE as string | null, recent = ["/work/marigold", "/work/other"], onStart = mock(async (_request: StartRequest) => ({ ok: true }) as { ok: true } | { ok: false; error: string }), availability = {} as Partial<Record<string, "missing" | "signed_out" | "untested_version">> } = {}) => {
    const folderRemote = mock(async (_folder: string) => remote);
    render(<SessionStartScreen recentFolders={recent} onBrowse={async () => null} onStart={onStart} cloud={{ folderRemote }} availability={availability} />);
    return { onStart, folderRemote };
  };
  const chooseCloud = () => fireEvent.click(screen.getByRole("radio", { name: "Draft cloud" }));
  const type = (label: string, value: string) => fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value } });
  const message = (value: string) => fireEvent.change(screen.getByRole("textbox", { name: "First message" }), { target: { value } });

  it("offers where it runs, with This computer selected and no repository fields", () => {
    cloudSetup();
    expect((screen.getByRole("radio", { name: "This computer" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("textbox", { name: "Repository" })).toBeNull();
    expect(screen.getByRole("button", { name: /marigold/ })).toBeTruthy();
  });

  it("fills the repository from the folder's git remote, in https form, and the branch with main", async () => {
    const { folderRemote } = cloudSetup({ remote: "git@github.com:acme/marigold.git" });
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
    expect(folderRemote).toHaveBeenCalledWith("/work/marigold");
    expect((screen.getByRole("textbox", { name: "Branch" }) as HTMLInputElement).value).toBe("main");
  });

  it("leaves the repository empty when the folder has no GitHub remote", async () => {
    cloudSetup({ remote: null });
    chooseCloud();
    await screen.findByRole("textbox", { name: "Repository" });
    expect((screen.getByRole("textbox", { name: "Repository" }) as HTMLInputElement).value).toBe("");
  });

  it("keeps a repository the person typed when another folder is picked", async () => {
    const { folderRemote } = cloudSetup({ recent: ["/work/marigold", "/work/other"], remote: REMOTE });
    chooseCloud();
    await waitFor(() => expect(folderRemote).toHaveBeenCalled());
    type("Repository", "https://github.com/acme/typed");
    fireEvent.click(screen.getByRole("button", { name: /marigold/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /other/ }));
    await waitFor(() => expect(folderRemote).toHaveBeenCalledWith("/work/other"));
    expect((screen.getByRole("textbox", { name: "Repository" }) as HTMLInputElement).value).toBe("https://github.com/acme/typed");
  });

  it("starts a cloud session with the repository, branch, restricted network and first message", async () => {
    const { onStart } = cloudSetup();
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
    message("  fix the build  ");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ runtime: "cloud", harness: "claude", gitRemote: REMOTE, branch: "main", network: "restricted", text: "fix the build", model: null, effort: null }));
  });

  it("sends the chosen branch, and an open network when the switch is on", async () => {
    const { onStart } = cloudSetup();
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
    type("Branch", "feature/login");
    fireEvent.click(screen.getByRole("switch", { name: "Open network" }));
    message("go");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ runtime: "cloud", branch: "feature/login", network: "open" })));
  });

  it("warns while the open network switch is on, and not otherwise", () => {
    cloudSetup();
    chooseCloud();
    expect(screen.queryByText("Anyone in this session can make the agent send data anywhere.")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Open network" }));
    expect(screen.getByText("Anyone in this session can make the agent send data anywhere.")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Open network" }));
    expect(screen.queryByText("Anyone in this session can make the agent send data anywhere.")).toBeNull();
  });

  it("offers only Claude Code, with a note, and moves a Codex choice to Claude", () => {
    cloudSetup();
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Codex" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GPT-6-Luna" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    chooseCloud();
    expect(screen.getByText("Cloud sessions run Claude Code.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    expect(screen.queryByRole("menuitemradio", { name: "Codex" })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "Opus" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Agent and model" }).textContent).toContain("Claude Code");
  });

  it("does not block on a Claude Code install on this computer", async () => {
    cloudSetup({ availability: { claude: "missing" } });
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
    fireEvent.change(screen.getByRole("textbox", { name: "First message" }), { target: { value: "go" } });
    expect(screen.queryByText("Claude Code is not installed on this computer.")).toBeNull();
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks Start for a repository it cannot clone, and says what is wrong beside the field", async () => {
    const { onStart } = cloudSetup({ remote: null });
    chooseCloud();
    message("go");
    type("Repository", "https://gitlab.com/acme/marigold");
    expect(screen.getByText("Use a GitHub repository address, such as https://github.com/owner/repo.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    type("Repository", REMOTE);
    type("Branch", "bad branch");
    expect(screen.getByText("Use a branch name, such as main.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("turns an SSH remote into the https address before it starts", async () => {
    const { onStart } = cloudSetup({ remote: null });
    chooseCloud();
    type("Repository", "git@github.com:acme/marigold.git");
    message("go");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ gitRemote: REMOTE })));
  });

  it("puts a repository error from the server under the repository field", async () => {
    const { onStart } = cloudSetup();
    onStart.mockImplementation(async () => ({ ok: false, error: "invalid_seed" }));
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
    message("go");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const alert = await screen.findByText("Draft cloud could not use this repository or branch. Check both.");
    expect(alert.className).toContain("ui-error");
    expect(alert.parentElement?.querySelector("input")).toBe(screen.getByRole("textbox", { name: "Repository" }) as HTMLInputElement);
    expect((screen.getByRole("textbox", { name: "First message" }) as HTMLTextAreaElement).value).toBe("go");
  });

  it("explains a missing Claude Code login, and that the start failed, below the form", async () => {
    const { onStart } = cloudSetup();
    onStart.mockImplementation(async () => ({ ok: false, error: "claude_not_connected" }));
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
    message("go");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This workspace has no Claude Code login. Connect Claude Code, then try again.");
    onStart.mockImplementation(async () => ({ ok: false, error: "start_failed" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The cloud session could not start. Try again.");
  });

  it("puts a network error beside the switch, and a code it does not know in the plain message", async () => {
    const { onStart } = cloudSetup();
    onStart.mockImplementation(async () => ({ ok: false, error: "invalid_network" }));
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
    message("go");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That network setting is not supported.");
    onStart.mockImplementation(async () => ({ ok: false, error: "request_failed_500" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByText("The cloud session could not start. Try again.")).toBeTruthy());
    expect((screen.getByRole("textbox", { name: "First message" }) as HTMLTextAreaElement).value).toBe("go");
  });

  it("goes back to the folder and computer setup when This computer is chosen again", async () => {
    cloudSetup();
    chooseCloud();
    expect(screen.getByRole("textbox", { name: "Repository" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "This computer" }));
    expect(screen.queryByRole("textbox", { name: "Repository" })).toBeNull();
    expect(screen.getByRole("button", { name: /marigold/ })).toBeTruthy();
  });

  it("keeps the local start unchanged, with no runtime in the request", async () => {
    const { onStart } = cloudSetup();
    message("go");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ harness: "claude", folderPath: "/work/marigold", text: "go", model: null, effort: null }));
    expect(onStart.mock.calls[0]![0]).not.toHaveProperty("runtime");
  });
});

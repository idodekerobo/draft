import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionStartScreen, type StartRequest, type StartResult } from "./SessionStartScreen";
import { EnvChecklist } from "./EnvChecklist";

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
    const envFiles = mock(async (_folder: string) => [] as string[]);
    render(<SessionStartScreen recentFolders={recent} onBrowse={async () => null} onStart={onStart} cloud={{ folderRemote, envFiles }} availability={availability} />);
    return { onStart, folderRemote };
  };
  const chooseCloud = () => fireEvent.click(screen.getByRole("radio", { name: "Draft cloud" }));
  const type = (label: string, value: string) => fireEvent.change(screen.getByRole(label === "Repository" ? "combobox" : "textbox", { name: label }), { target: { value } });
  const message = (value: string) => fireEvent.change(screen.getByRole("textbox", { name: "First message" }), { target: { value } });

  it("offers where it runs, with This computer selected and no repository fields", () => {
    cloudSetup();
    expect((screen.getByRole("radio", { name: "This computer" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("combobox", { name: "Repository" })).toBeNull();
    expect(screen.getByRole("button", { name: /marigold/ })).toBeTruthy();
  });

  it("fills the repository from the folder's git remote, in https form, and the branch with main", async () => {
    const { folderRemote } = cloudSetup({ remote: "git@github.com:acme/marigold.git" });
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
    expect(folderRemote).toHaveBeenCalledWith("/work/marigold");
    expect((screen.getByRole("textbox", { name: "Branch" }) as HTMLInputElement).value).toBe("main");
  });

  it("leaves the repository empty when the folder has no GitHub remote", async () => {
    cloudSetup({ remote: null });
    chooseCloud();
    await screen.findByRole("combobox", { name: "Repository" });
    expect((screen.getByRole("combobox", { name: "Repository" }) as HTMLInputElement).value).toBe("");
  });

  it("hides the folder picker for a repository, says where a suggested repository came from, and keeps one the person typed", async () => {
    const { folderRemote } = cloudSetup({ recent: ["/work/marigold", "/work/other"], remote: REMOTE });
    chooseCloud();
    await waitFor(() => expect(folderRemote).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /marigold/ })).toBeNull();
    expect(await screen.findByText(/From marigold/)).toBeTruthy();
    type("Repository", "https://github.com/acme/typed");
    expect(screen.queryByText(/From marigold/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "This folder (snapshot)" }));
    fireEvent.click(screen.getByRole("radio", { name: "GitHub repository" }));
    expect((screen.getByRole("combobox", { name: "Repository" }) as HTMLInputElement).value).toBe("https://github.com/acme/typed");
  });

  it("starts a cloud session with the repository, branch, restricted network and first message", async () => {
    const { onStart } = cloudSetup();
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
    message("  fix the build  ");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith({ runtime: "cloud", harness: "claude", source: "repo", gitRemote: REMOTE, branch: "main", network: "restricted", text: "fix the build", model: null, effort: null }));
  });

  it("sends the chosen branch, and an open network when the switch is on", async () => {
    const { onStart } = cloudSetup();
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
    type("Branch", "feature/login");
    fireEvent.click(screen.getByRole("switch", { name: "Open network access" }));
    message("go");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ runtime: "cloud", branch: "feature/login", network: "open" })));
  });

  it("warns while the open network switch is on, and not otherwise", () => {
    cloudSetup();
    chooseCloud();
    expect(screen.queryByText("Anyone in this session can make the agent send data anywhere.")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Open network access" }));
    expect(screen.getByText("Anyone in this session can make the agent send data anywhere.")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Open network access" }));
    expect(screen.queryByText("Anyone in this session can make the agent send data anywhere.")).toBeNull();
  });

  it("shows Codex as coming soon, keeps Claude Code chosen, and moves a Codex choice to Claude", () => {
    cloudSetup();
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Codex" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "GPT-6-Luna" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    chooseCloud();
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    const codex = screen.getByRole("menuitemradio", { name: /Codex/ });
    expect(codex.textContent).toContain("Coming soon");
    expect(codex.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(codex);
    expect(screen.getByRole("menuitemradio", { name: "Opus" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Agent and model" }).textContent).toContain("Claude Code");
  });

  it("does not block on a Claude Code install on this computer", async () => {
    cloudSetup({ availability: { claude: "missing" } });
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
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
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
    message("go");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const alert = await screen.findByText("Draft cloud could not use this repository or branch. Check both.");
    expect(alert.className).toContain("ui-error");
    expect(alert.parentElement?.querySelector("input")).toBe(screen.getByRole("combobox", { name: "Repository" }) as HTMLInputElement);
    expect((screen.getByRole("textbox", { name: "First message" }) as HTMLTextAreaElement).value).toBe("go");
  });

  it("explains a missing Claude Code login, and that the start failed, below the form", async () => {
    const { onStart } = cloudSetup();
    onStart.mockImplementation(async () => ({ ok: false, error: "claude_not_connected" }));
    chooseCloud();
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
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
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Repository" }) as HTMLInputElement).value).toBe(REMOTE));
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
    expect(screen.getByRole("combobox", { name: "Repository" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "This computer" }));
    expect(screen.queryByRole("combobox", { name: "Repository" })).toBeNull();
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

describe("SessionStartScreen in Draft cloud from a folder snapshot", () => {
  const WARNING = "Anyone in this session can ask the agent to read these.";
  const chooseCloud = () => fireEvent.click(screen.getByRole("radio", { name: "Draft cloud" }));
  const chooseSnapshot = () => fireEvent.click(screen.getByRole("radio", { name: "This folder (snapshot)" }));
  const message = (value: string) => fireEvent.change(screen.getByRole("textbox", { name: "First message" }), { target: { value } });
  const startButton = () => screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;

  function snapshotSetup({
    recent = ["/work/marigold", "/work/other"],
    envFiles = mock(async (_folder: string) => [".env", ".env.local"]),
    onStart = mock(async (_request: StartRequest) => ({ ok: true }) as StartResult),
  }: {
    recent?: string[];
    envFiles?: (folder: string) => Promise<string[]>;
    onStart?: (request: StartRequest) => Promise<StartResult>;
  } = {}) {
    const folderRemote = mock(async (_folder: string) => "https://github.com/acme/marigold");
    render(<SessionStartScreen recentFolders={recent} onBrowse={async () => null} onStart={onStart} cloud={{ folderRemote, envFiles }} />);
    return { onStart, envFiles };
  }

  it("offers the GitHub repository first, and This folder (snapshot) as the other source", () => {
    snapshotSetup();
    chooseCloud();
    expect((screen.getByRole("radio", { name: "GitHub repository" }) as HTMLElement).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "This folder (snapshot)" })).toBeTruthy();
  });

  it("lists the folder's .env files with none ticked and the warning, and drops the repository fields", async () => {
    const { envFiles } = snapshotSetup();
    chooseCloud();
    chooseSnapshot();
    expect(await screen.findByRole("checkbox", { name: ".env" })).toBeTruthy();
    expect(envFiles).toHaveBeenCalledWith("/work/marigold");
    for (const box of screen.getAllByRole("checkbox")) expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("checkbox", { name: ".env.local" })).toBeTruthy();
    expect(screen.getByText(WARNING)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Repository" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Branch" })).toBeNull();
  });

  it("says there are no .env files, with no warning, when the folder has none", async () => {
    snapshotSetup({ envFiles: mock(async (_folder: string) => []) });
    chooseCloud();
    chooseSnapshot();
    expect(await screen.findByText("No .env files in this folder.")).toBeTruthy();
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it("keeps Start disabled until the checklist has loaded", async () => {
    let finish: (files: string[]) => void = () => {};
    const envFiles = mock(() => new Promise<string[]>((resolve) => { finish = resolve; }));
    snapshotSetup({ envFiles });
    chooseCloud();
    chooseSnapshot();
    message("go");
    expect(startButton().disabled).toBe(true);
    await act(async () => finish([".env"]));
    await screen.findByRole("checkbox", { name: ".env" });
    expect(startButton().disabled).toBe(false);
  });

  it("starts the snapshot with only the ticked .env files, the folder, and the first message", async () => {
    const { onStart } = snapshotSetup();
    chooseCloud();
    chooseSnapshot();
    fireEvent.click(await screen.findByRole("checkbox", { name: ".env.local" }));
    message("  fix the build  ");
    fireEvent.click(startButton());
    await waitFor(() =>
      expect((onStart as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toEqual({
        runtime: "cloud",
        harness: "claude",
        source: "snapshot",
        folderPath: "/work/marigold",
        includeEnvFiles: [".env.local"],
        network: "restricted",
        text: "fix the build",
        model: null,
        effort: null,
      }),
    );
  });

  it("sends no .env file when none is ticked, and the open network when its switch is on", async () => {
    const { onStart } = snapshotSetup();
    chooseCloud();
    chooseSnapshot();
    await screen.findByRole("checkbox", { name: ".env" });
    fireEvent.click(screen.getByRole("switch", { name: "Open network access" }));
    message("go");
    fireEvent.click(startButton());
    await waitFor(() => expect((onStart as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toEqual(expect.objectContaining({ source: "snapshot", includeEnvFiles: [], network: "open" })));
  });

  it("clears the ticks when another folder is picked", async () => {
    snapshotSetup();
    chooseCloud();
    chooseSnapshot();
    fireEvent.click(await screen.findByRole("checkbox", { name: ".env" }));
    expect((screen.getByRole("checkbox", { name: ".env" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /marigold/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /other/ }));
    await waitFor(() => expect((screen.getByRole("checkbox", { name: ".env" }) as HTMLInputElement).checked).toBe(false));
  });

  it("says the checklist could not be read, and starts with no .env file", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const { onStart } = snapshotSetup({ envFiles: mock(async (_folder: string) => { throw new Error("denied"); }) });
    chooseCloud();
    chooseSnapshot();
    expect(await screen.findByText("Draft could not read this folder's .env files, so none will be included.")).toBeTruthy();
    message("go");
    fireEvent.click(startButton());
    await waitFor(() => expect((onStart as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]).toEqual(expect.objectContaining({ source: "snapshot", includeEnvFiles: [] })));
    consoleError.mockRestore();
  });

  it("shows the size refusal with its own sentence, under the form", async () => {
    const detail = "This folder packs to 212.4 MB. Snapshots are limited to 200 MB, so move large files out of the folder or use a GitHub repository.";
    snapshotSetup({ onStart: mock(async () => ({ ok: false, error: "snapshot_too_large", detail }) as StartResult) });
    chooseCloud();
    chooseSnapshot();
    await screen.findByRole("checkbox", { name: ".env" });
    message("go");
    fireEvent.click(startButton());
    const alert = await screen.findByText(detail);
    expect(alert.getAttribute("role")).toBe("alert");
  });

  it("puts a snapshot's server refusal under the form, not under the repository field it does not show", async () => {
    snapshotSetup({ onStart: mock(async () => ({ ok: false, error: "invalid_seed" }) as StartResult) });
    chooseCloud();
    chooseSnapshot();
    await screen.findByRole("checkbox", { name: ".env" });
    message("go");
    fireEvent.click(startButton());
    expect((await screen.findByRole("alert")).textContent).toBe("Draft cloud could not use this folder. Try again.");
    expect((screen.getByRole("textbox", { name: "First message" }) as HTMLTextAreaElement).value).toBe("go");
  });

  it("asks for a folder before a snapshot can start", () => {
    snapshotSetup({ recent: [] });
    chooseCloud();
    chooseSnapshot();
    expect(screen.getByText("Choose a folder to copy.")).toBeTruthy();
    message("go");
    expect(startButton().disabled).toBe(true);
  });
});

describe("SessionStartScreen GitHub connection", () => {
  it("lets a cloud start go ahead without GitHub, says what is missing, and opens the place to connect it", async () => {
    const onConnectGithub = mock(() => {});
    render(<SessionStartScreen recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={async () => ({ ok: true })} cloud={{ folderRemote: async () => null, envFiles: async () => [], githubConnected: false, onConnectGithub }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Draft cloud" }));
    expect(screen.getByText(/GitHub is not connected/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "First message" }), { target: { value: "hi" } });
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    expect(onConnectGithub).toHaveBeenCalled();
  });
});

describe("EnvChecklist", () => {
  it("ticks every file under a folder, and shows a folder as mixed when only some are ticked", () => {
    const onToggle = mock((_files: string[], _on: boolean) => {});
    const view = render(<EnvChecklist files={[".claude/a/.env", ".claude/b/.env"]} ticked={[]} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "All .env files in .claude" }));
    expect(onToggle).toHaveBeenCalledWith([".claude/a/.env", ".claude/b/.env"], true);
    view.rerender(<EnvChecklist files={[".claude/a/.env", ".claude/b/.env"]} ticked={[".claude/a/.env"]} onToggle={onToggle} />);
    expect((screen.getByRole("checkbox", { name: "All .env files in .claude" }) as HTMLInputElement).indeterminate).toBe(true);
  });
});

describe("SessionStartScreen branch list", () => {
  it("lists the repository's branches and takes its default branch until the person types one", async () => {
    const branches = mock(async (_repo: string) => ({ defaultBranch: "develop", branches: ["develop", "main", "feature/x"] }));
    render(<SessionStartScreen recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={async () => ({ ok: true })} cloud={{ folderRemote: async () => "https://github.com/acme/marigold", envFiles: async () => [], branches }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Draft cloud" }));
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Branch" }) as HTMLInputElement).value).toBe("develop"));
    expect(branches).toHaveBeenCalledWith("acme/marigold");
    expect(document.querySelectorAll("datalist option").length).toBeGreaterThanOrEqual(3);
  });
});

describe("SessionStartScreen empty project", () => {
  it("starts with no repository and no branch when the repository is left empty", async () => {
    const onStart = mock(async (_request: StartRequest) => ({ ok: true }) as StartResult);
    render(<SessionStartScreen recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={onStart} cloud={{ folderRemote: async () => null, envFiles: async () => [], githubConnected: true }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Draft cloud" }));
    expect(screen.queryByRole("textbox", { name: "Branch" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "First message" }), { target: { value: "start fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ source: "repo", gitRemote: "", branch: "" })));
  });
});

describe("SessionStartScreen snapshot size", () => {
  const setup = (bytes: number) => {
    render(<SessionStartScreen recentFolders={["/work/marigold"]} onBrowse={async () => null} onStart={async () => ({ ok: true })} cloud={{ folderRemote: async () => null, envFiles: async () => [], folderSize: async () => ({ bytes, fileCount: 1200 }), githubConnected: true }} />);
    fireEvent.click(screen.getByRole("radio", { name: "Draft cloud" }));
    fireEvent.click(screen.getByRole("radio", { name: "This folder (snapshot)" }));
    fireEvent.change(screen.getByRole("textbox", { name: "First message" }), { target: { value: "hi" } });
  };
  const start = () => screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;

  it("shows a small folder's size and lets it start", async () => {
    setup(20 * 1024 * 1024);
    expect(await screen.findByText("1,200 files, 20 MB")).toBeTruthy();
    await waitFor(() => expect(start().disabled).toBe(false));
  });

  it("warns that a large folder takes a while", async () => {
    setup(300 * 1024 * 1024);
    expect(await screen.findByText(/Copying it may take a few minutes/)).toBeTruthy();
  });

  it("refuses a folder over the limit before Start", async () => {
    setup(2 * 1024 * 1024 * 1024);
    expect(await screen.findByText(/over the 1 GB limit/)).toBeTruthy();
    expect(start().disabled).toBe(true);
  });
});

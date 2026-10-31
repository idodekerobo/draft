import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense, type ReactNode } from "react";
import { DraftApiProvider, type DraftApi } from "../query/api";
import { RoutineError } from "./errors";
import { RoutinesPanel } from "./RoutinesPanel";
import type { CreateRoutineInput, Routine, RoutineAgentStatus, RoutineRun, RoutinesResponse } from "./types";

afterEach(cleanup);

function agentRoutine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: "digest",
    taskType: "agent_routine",
    title: "Weekly digest",
    routineDescription: "Runs an agent on this schedule.",
    scheduleDescription: "Daily at 9:00 AM",
    preset: "daily",
    time: "09:00",
    weekday: null,
    timezone: "UTC",
    cron: null,
    intervalSeconds: null,
    enabled: true,
    editable: "full",
    connectionLabel: null,
    needsReconnect: false,
    nextRunAt: "2099-01-01T09:00:00.000Z",
    lastCheckedAt: null,
    lastRun: null,
    updatedByName: null,
    agent: {
      prompt: "Summarize the week.",
      harness: "claude",
      model: "haiku",
      createdByName: "Maya",
      lastRun: { id: "run-2", status: "failed", startedAt: "2026-10-27T09:00:00.000Z", endedAt: "2026-10-27T09:01:00.000Z" },
    },
    ...overrides,
  };
}

const runs: RoutineRun[] = [
  { id: "run-2", status: "failed", startedAt: "2026-10-27T09:00:00.000Z", endedAt: "2026-10-27T09:01:00.000Z" },
  { id: "run-1", status: "completed", startedAt: "2026-10-26T09:00:00.000Z", endedAt: "2026-10-26T09:03:00.000Z" },
];

function setup(options: { canEdit?: boolean; routines?: Routine[]; createRoutine?: DraftApi["createRoutine"]; updateRoutine?: DraftApi["updateRoutine"]; deleteRoutine?: DraftApi["deleteRoutine"]; agents?: RoutinesResponse["agents"]; renderAgentSetup?: (harness: string, status: RoutineAgentStatus, refresh: () => void) => ReactNode; initialOpenId?: string } = {}) {
  const response: RoutinesResponse = { routines: options.routines ?? [agentRoutine()], canEdit: options.canEdit ?? true, agents: options.agents };
  const getRoutineRuns = mock(async () => runs);
  const createRoutine = mock(options.createRoutine ?? (async (input: CreateRoutineInput) => agentRoutine({ id: "new", title: input.title, agent: { prompt: input.prompt, harness: "claude", model: input.model, createdByName: "Maya", lastRun: null } })));
  const updateRoutine = mock(options.updateRoutine ?? (async () => response.routines[0]!));
  const deleteRoutine = mock(options.deleteRoutine ?? (async () => {}));
  const onOpenRun = mock((_id: string, _routine: { id: string; title: string }) => {});
  const api: DraftApi = { getRuns: async () => [], getRoutines: async () => ({ ...response }), updateRoutine, createRoutine, deleteRoutine, getRoutineRuns };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DraftApiProvider api={api}>
        <Suspense fallback="loading">
          <RoutinesPanel workspaceId="ws-1" onOpenRun={onOpenRun} renderAgentSetup={options.renderAgentSetup} initialOpenId={options.initialOpenId} />
        </Suspense>
      </DraftApiProvider>
    </QueryClientProvider>,
  );
  return { createRoutine, updateRoutine, deleteRoutine, getRoutineRuns, onOpenRun, response };
}

const ready = () => screen.findByRole("button", { name: /^All/ });

describe("agent routines in the list", () => {
  it("shows the agent and model under the name and the newest run's outcome", async () => {
    setup();
    await ready();
    expect(screen.getByText("Claude Code · Haiku")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("says a routine has not run yet", async () => {
    setup({ routines: [agentRoutine({ agent: { ...agentRoutine().agent!, lastRun: null } })] });
    await ready();
    expect(screen.getByText("No runs yet")).toBeTruthy();
  });
});

describe("run history", () => {
  it("lists the runs in the details and opens one", async () => {
    const { onOpenRun } = setup();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Weekly digest" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText("What should it do?") as HTMLTextAreaElement).value).toBe("Summarize the week.");
    const rows = await within(dialog).findAllByRole("button", { name: /Completed|Failed/ });
    expect(rows).toHaveLength(2);

    fireEvent.click(rows[1]!);
    expect(onOpenRun).toHaveBeenCalledWith("run-1", expect.objectContaining({ id: "digest", title: "Weekly digest" }));
  });

  it("opens the routine's details at first when it is told where a person came back from", async () => {
    setup({ initialOpenId: "digest" });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Weekly digest" })).toBeTruthy();
  });

  it("is already loaded when the dialog opens, so no loading state flashes", async () => {
    const { getRoutineRuns } = setup();
    await ready();
    const link = screen.getByRole("button", { name: "Weekly digest" });
    fireEvent.pointerEnter(link);
    await waitFor(() => expect(getRoutineRuns).toHaveBeenCalledTimes(1));

    fireEvent.click(link);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("status", { name: "Loading runs" })).toBeNull();
    expect(within(dialog).getAllByRole("button", { name: /Completed|Failed/ })).toHaveLength(2);
    expect(getRoutineRuns).toHaveBeenCalledTimes(1);
  });
});

describe("creating a routine", () => {
  it("sends the request with the chosen schedule and adds the routine to the list", async () => {
    const { createRoutine } = setup({ routines: [] });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New routine" }));
    const dialog = await screen.findByRole("dialog");

    const create = within(dialog).getByRole("button", { name: "Create routine" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "  Launch watch " } });
    fireEvent.change(within(dialog).getByLabelText("What should it do?"), { target: { value: "List launch risks." } });
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "08:30" } });
    expect(create.disabled).toBe(false);

    await act(async () => fireEvent.click(create));
    await waitFor(() => expect(createRoutine).toHaveBeenCalledTimes(1));
    expect(createRoutine.mock.calls[0]![0]).toMatchObject({ title: "Launch watch", prompt: "List launch risks.", harness: "claude", model: null, preset: "daily", time: "08:30" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Launch watch" })).toBeTruthy();
  });

  it("keeps the dialog open and shows the error beside the field", async () => {
    setup({ createRoutine: async () => { throw new RoutineError("Enter a name for this routine.", "title"); } });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New routine" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "x" } });
    fireEvent.change(within(dialog).getByLabelText("What should it do?"), { target: { value: "y" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Create routine" })));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("Enter a name for this routine.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("hides New routine from view-only members", async () => {
    setup({ canEdit: false });
    await ready();
    expect(screen.queryByRole("button", { name: "New routine" })).toBeNull();
  });
});

describe("an agent that is not connected for routines", () => {
  const chooseCodex = async () => {
    fireEvent.click(screen.getByRole("button", { name: "New routine" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Digest" } });
    fireEvent.change(within(dialog).getByLabelText("What should it do?"), { target: { value: "Summarize." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Agent and model" }));
    return dialog;
  };

  it("marks the agent in the picker, shows what to do, and blocks Create until it is connected", async () => {
    setup({ routines: [], agents: { claude: "connected", codex: "not_connected" }, renderAgentSetup: (harness) => (harness === "codex" ? <p>Connect Codex here</p> : null) });
    await ready();
    const dialog = await chooseCodex();
    expect(within(dialog).getByRole("menuitemradio", { name: /Codex/ }).textContent).toContain("Connect");
    expect(within(dialog).getByRole("menuitemradio", { name: /Claude Code/ }).textContent).not.toContain("Connect");

    expect(within(dialog).queryByText("Connect Codex here")).toBeNull();
    fireEvent.click(within(dialog).getByRole("menuitemradio", { name: /Codex/ }));
    expect(within(dialog).getByText("Connect Codex here")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Create routine" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says where to connect when the app has no way to do it here", async () => {
    setup({ routines: [], agents: { codex: "needs_reconnect" } });
    await ready();
    const dialog = await chooseCodex();
    fireEvent.click(within(dialog).getByRole("menuitemradio", { name: /Codex/ }));
    expect(within(dialog).getByRole("status").textContent).toContain("Codex is not connected for routines");
    expect((within(dialog).getByRole("button", { name: "Create routine" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("turns Create on once the setup reports the agent connected and the statuses are read again", async () => {
    const { response } = setup({
      routines: [],
      agents: { codex: "not_connected" },
      renderAgentSetup: (_harness, _status, refresh) => (
        <button type="button" onClick={refresh}>Finished connecting</button>
      ),
    });
    await ready();
    const dialog = await chooseCodex();
    fireEvent.click(within(dialog).getByRole("menuitemradio", { name: /Codex/ }));
    const create = within(dialog).getByRole("button", { name: "Create routine" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    response.agents = { codex: "connected" };
    fireEvent.click(within(dialog).getByRole("button", { name: "Finished connecting" }));
    await waitFor(() => expect(create.disabled).toBe(false));
    expect(within(dialog).queryByRole("button", { name: "Finished connecting" })).toBeNull();
  });

  it("does not block an agent the list says nothing about", async () => {
    setup({ routines: [] });
    await ready();
    const dialog = await chooseCodex();
    fireEvent.click(within(dialog).getByRole("menuitemradio", { name: /Codex/ }));
    expect((within(dialog).getByRole("button", { name: "Create routine" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("editing a routine", () => {
  const open = async (name = "Weekly digest") => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name }));
    return screen.findByRole("dialog");
  };
  const save = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "Save changes" }) as HTMLButtonElement;

  it("fills the fields with what the routine does now, and saves nothing until something changes", async () => {
    setup();
    const dialog = await open();
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Weekly digest");
    expect((within(dialog).getByLabelText("What should it do?") as HTMLTextAreaElement).value).toBe("Summarize the week.");
    expect(within(dialog).getByRole("button", { name: "Agent and model" }).textContent).toContain("Claude Code · Haiku");
    expect(save(dialog).disabled).toBe(true);
  });

  it("sends only the fields that changed and says past runs keep what they ran with", async () => {
    const { updateRoutine } = setup({ updateRoutine: async () => agentRoutine({ title: "Monday digest" }) });
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "  Monday digest " } });
    expect(within(dialog).getByText(/Past runs keep the prompt and agent they ran with/)).toBeTruthy();

    await act(async () => fireEvent.click(save(dialog)));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledTimes(1));
    expect(updateRoutine.mock.calls[0]).toEqual(["digest", { title: "Monday digest" }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Monday digest" })).toBeTruthy();
  });

  it("keeps Save off for an empty prompt", async () => {
    setup();
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("What should it do?"), { target: { value: "   " } });
    expect(save(dialog).disabled).toBe(true);
  });

  it("changes the schedule and the prompt in one save", async () => {
    const { updateRoutine } = setup();
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("What should it do?"), { target: { value: "Summarize Monday." } });
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "07:15" } });
    await act(async () => fireEvent.click(save(dialog)));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledTimes(1));
    expect(updateRoutine.mock.calls[0]![1]).toMatchObject({ prompt: "Summarize Monday.", preset: "daily", time: "07:15" });
  });

  it("switches to a connected agent and drops the old model", async () => {
    const { updateRoutine } = setup({ agents: { claude: "connected", codex: "connected" } });
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Agent and model" }));
    fireEvent.click(within(dialog).getByRole("menuitemradio", { name: /Codex/ }));
    expect(save(dialog).disabled).toBe(false);

    await act(async () => fireEvent.click(save(dialog)));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledTimes(1));
    expect(updateRoutine.mock.calls[0]![1]).toEqual({ harness: "codex", model: null });
  });

  it("blocks Save and shows the connect help when the new agent is not connected", async () => {
    setup({ agents: { claude: "connected", codex: "not_connected" }, renderAgentSetup: (harness) => (harness === "codex" ? <p>Connect Codex here</p> : null) });
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Agent and model" }));
    fireEvent.click(within(dialog).getByRole("menuitemradio", { name: /Codex/ }));
    expect(within(dialog).getByText("Connect Codex here")).toBeTruthy();
    expect(save(dialog).disabled).toBe(true);
  });

  it("keeps the dialog open and shows the server's message beside the field", async () => {
    setup({ updateRoutine: async () => { throw new RoutineError("Describe what the routine should do.", "prompt"); } });
    const dialog = await open();
    fireEvent.change(within(dialog).getByLabelText("What should it do?"), { target: { value: "New." } });
    await act(async () => fireEvent.click(save(dialog)));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Describe what the routine should do.");
  });

  it("is read-only for a view-only member", async () => {
    setup({ canEdit: false });
    const dialog = await open();
    expect(within(dialog).getByText("Summarize the week.")).toBeTruthy();
    expect(within(dialog).queryByLabelText("What should it do?")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Delete routine" })).toBeNull();
  });
});

describe("deleting a routine", () => {
  const open = async () => {
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Weekly digest" }));
    return screen.findByRole("dialog");
  };

  it("asks first, and Keep routine goes back without deleting", async () => {
    const { deleteRoutine } = setup();
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete routine" }));

    const confirm = within(dialog).getByRole("group", { name: "Confirm delete" });
    expect(within(confirm).getByText(/Its past runs stay/)).toBeTruthy();
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "Keep routine" }));

    fireEvent.click(within(confirm).getByRole("button", { name: "Keep routine" }));
    expect(within(dialog).queryByRole("group", { name: "Confirm delete" })).toBeNull();
    expect(deleteRoutine).not.toHaveBeenCalled();
  });

  it("deletes the routine, closes the dialog and takes it off the list", async () => {
    const { deleteRoutine } = setup();
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete routine" }));
    await act(async () => fireEvent.click(within(within(dialog).getByRole("group", { name: "Confirm delete" })).getByRole("button", { name: "Delete routine" })));

    await waitFor(() => expect(deleteRoutine).toHaveBeenCalledWith("digest"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Weekly digest" })).toBeNull();
  });

  it("keeps the routine and says so when the delete fails", async () => {
    setup({ deleteRoutine: async () => { throw new RoutineError("This routine no longer exists. Refresh and try again."); } });
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete routine" }));
    await act(async () => fireEvent.click(within(within(dialog).getByRole("group", { name: "Confirm delete" })).getByRole("button", { name: "Delete routine" })));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("no longer exists");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("is not offered for a built-in routine", async () => {
    setup({ routines: [agentRoutine({ id: "sessions", taskType: "summarize_sessions", title: "Summarize coding sessions", agent: null })] });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Summarize coding sessions" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Delete routine" })).toBeNull();
  });
});

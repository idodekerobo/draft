import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense } from "react";
import { DraftApiProvider, type DraftApi } from "../query/api";
import { RoutineError } from "./errors";
import { RoutinesPanel } from "./RoutinesPanel";
import type { CreateRoutineInput, Routine, RoutineRun, RoutinesResponse } from "./types";

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

function setup(options: { canEdit?: boolean; routines?: Routine[]; createRoutine?: DraftApi["createRoutine"] } = {}) {
  const response: RoutinesResponse = { routines: options.routines ?? [agentRoutine()], canEdit: options.canEdit ?? true };
  const getRoutineRuns = mock(async () => runs);
  const createRoutine = mock(options.createRoutine ?? (async (input: CreateRoutineInput) => agentRoutine({ id: "new", title: input.title, agent: { prompt: input.prompt, harness: "claude", model: input.model, createdByName: "Maya", lastRun: null } })));
  const onOpenRun = mock((_id: string) => {});
  const api: DraftApi = { getRuns: async () => [], getRoutines: async () => response, updateRoutine: async () => response.routines[0]!, createRoutine, getRoutineRuns };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DraftApiProvider api={api}>
        <Suspense fallback="loading">
          <RoutinesPanel workspaceId="ws-1" onOpenRun={onOpenRun} />
        </Suspense>
      </DraftApiProvider>
    </QueryClientProvider>,
  );
  return { createRoutine, getRoutineRuns, onOpenRun };
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
    expect(within(dialog).getByText("Summarize the week.")).toBeTruthy();
    const rows = await within(dialog).findAllByRole("button", { name: /Completed|Failed/ });
    expect(rows).toHaveLength(2);

    fireEvent.click(rows[1]!);
    expect(onOpenRun).toHaveBeenCalledWith("run-1");
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

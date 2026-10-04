import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense } from "react";
import { DraftApiProvider, type DraftApi } from "../query/api";
import { RoutinesPanel } from "./RoutinesPanel";
import type { Routine, RoutinesResponse } from "./types";

afterEach(cleanup);

function routine(overrides: Partial<Routine>): Routine {
  return {
    id: "synth",
    taskType: "synthesize_workspace",
    title: "Company context synthesis",
    routineDescription: "Uses new source material to update your company context.",
    scheduleDescription: "Draft default",
    preset: "draft_default",
    time: null,
    weekday: null,
    timezone: "UTC",
    enabled: true,
    editable: "full",
    connectionLabel: null,
    needsReconnect: false,
    nextRunAt: "2099-01-01T10:00:00.000Z",
    lastCheckedAt: null,
    lastRun: null,
    updatedByName: null,
    ...overrides,
  };
}

const baseRoutines = (): Routine[] => [
  routine({}),
  routine({
    id: "sessions",
    taskType: "summarize_sessions",
    title: "Coding session summaries",
    scheduleDescription: "Daily at 03:00 (UTC)",
    preset: "daily",
    time: "03:00",
    enabled: false,
    nextRunAt: null,
  }),
  routine({
    id: "slack",
    taskType: "ingest_source",
    title: "Slack import",
    editable: "toggle_only",
    connectionLabel: "Acme Slack",
    needsReconnect: true,
    preset: "custom",
  }),
];

function setup(options: { canEdit?: boolean; routines?: Routine[]; updateRoutine?: DraftApi["updateRoutine"] } = {}) {
  const response: RoutinesResponse = { routines: options.routines ?? baseRoutines(), canEdit: options.canEdit ?? true };
  const updateRoutine = mock(options.updateRoutine ?? (async (id: string) => ({ ...response.routines.find((r) => r.id === id)! })));
  const api: DraftApi = { getRuns: async () => [], getRoutines: async () => response, updateRoutine };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <DraftApiProvider api={api}>
        <Suspense fallback="loading">
          <RoutinesPanel workspaceId="ws-1" />
        </Suspense>
      </DraftApiProvider>
    </QueryClientProvider>,
  );
  return { ...view, updateRoutine };
}

async function ready() {
  return screen.findByRole("heading", { name: "Routines" });
}

describe("RoutinesPanel", () => {
  it("shows counts, no-result and reconnect states", async () => {
    setup();
    await ready();
    expect(screen.getByRole("button", { name: /^All\s*3/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Active\s*2/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Paused\s*1/ })).toBeTruthy();
    expect(screen.getByText("No result yet")).toBeTruthy();
    expect(screen.getByText("Needs reconnect")).toBeTruthy();
    expect(within(screen.getByRole("table")).getByText("Paused")).toBeTruthy();
    const slackSwitch = screen.getByRole("switch", { name: "Slack import" }) as HTMLButtonElement;
    expect(slackSwitch.disabled).toBe(true);
  });

  it("filters by status and search, keeping counts for the full list", async () => {
    setup();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /^Paused/ }));
    expect(screen.queryByText("Company context synthesis")).toBeNull();
    expect(screen.getByText("Coding session summaries")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search routines"), { target: { value: "  acme " } });
    expect(screen.getByText("No routines match your filters.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^All\s*3/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(screen.getByText("Slack import")).toBeTruthy();
  });

  it("toggles optimistically and rolls back when the save fails", async () => {
    let reject!: (error: Error) => void;
    const { updateRoutine } = setup({
      updateRoutine: () => new Promise((_resolve, rej) => { reject = rej; }),
    });
    await ready();
    const toggle = screen.getByRole("switch", { name: "Company context synthesis" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(updateRoutine).toHaveBeenCalledWith("synth", { enabled: false });

    await act(async () => reject(new Error("nope")));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables every switch for view-only members", async () => {
    setup({ canEdit: false });
    await ready();
    for (const toggle of screen.getAllByRole("switch")) expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens details, closes with Escape and the Close button, and restores focus", async () => {
    setup();
    await ready();
    const trigger = screen.getByRole("button", { name: "Company context synthesis" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { hidden: true });
    expect(within(dialog).getByText(/Uses new source material/)).toBeTruthy();

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Close", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
  });

  it("explains toggle-only routines without an editor", async () => {
    setup();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Slack import" }));
    const dialog = await screen.findByRole("dialog", { hidden: true });
    expect(within(dialog).getByText(/managed for you/)).toBeTruthy();
    expect(within(dialog).queryByLabelText("Frequency")).toBeNull();
  });

  it("saves a new schedule and warns about hourly cadence", async () => {
    const { updateRoutine } = setup({
      updateRoutine: async (id, patch) => ({ ...routine({ id: "sessions" }), ...("preset" in patch ? { preset: patch.preset } : {}) }) as Routine,
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Coding session summaries" }));
    const dialog = await screen.findByRole("dialog", { hidden: true });

    fireEvent.change(within(dialog).getByLabelText("Frequency"), { target: { value: "hourly" } });
    expect(within(dialog).getByRole("note").textContent).toMatch(/Claude quota/);

    fireEvent.click(within(dialog).getByRole("button", { name: "Save schedule" }));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalled());
    const [id, patch] = updateRoutine.mock.calls[0]!;
    expect(id).toBe("sessions");
    expect(patch).toMatchObject({ preset: "hourly" });
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
  });

  it("keeps the dialog open and shows the error beside the field when saving fails", async () => {
    setup({
      updateRoutine: async () => {
        throw Object.assign(new Error("Time must be HH:MM"), { field: "time" });
      },
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Coding session summaries" }));
    const dialog = await screen.findByRole("dialog", { hidden: true });

    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "04:15" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save schedule" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Time must be HH:MM");
    expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
  });

  it("shows the empty state", async () => {
    setup({ routines: [] });
    await ready();
    expect(screen.getByText("No routines yet. Contact Draft.")).toBeTruthy();
  });
});

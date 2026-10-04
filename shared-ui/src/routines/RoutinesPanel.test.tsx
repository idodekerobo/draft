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
    title: "Update company context",
    routineDescription: "Uses new source material to update your company context.",
    scheduleDescription: "Hourly, 9 AM–6 PM; every ~4h overnight",
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
    title: "Summarize coding sessions",
    scheduleDescription: "Daily at 3:00 AM",
    preset: "daily",
    time: "03:00",
    enabled: false,
    nextRunAt: null,
  }),
  routine({
    id: "slack",
    taskType: "ingest_source",
    title: "Sync Slack",
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
  return screen.findByRole("button", { name: /^All/ });
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
    expect(screen.getAllByText("Paused").length).toBeGreaterThan(1);
    const slackSwitch = screen.getByRole("switch", { name: "Sync Slack Acme Slack enabled" }) as HTMLButtonElement;
    expect(slackSwitch.disabled).toBe(true);
  });

  it("filters by status and search, keeping counts for the full list", async () => {
    setup();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: /^Paused/ }));
    expect(screen.queryByText("Update company context")).toBeNull();
    expect(screen.getByText("Summarize coding sessions")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search routines"), { target: { value: "  acme " } });
    expect(screen.getByText("No matching routines")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^All\s*3/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect(screen.getByText("Sync Slack")).toBeTruthy();
  });

  it("toggles optimistically and rolls back when the save fails", async () => {
    let reject!: (error: Error) => void;
    const { updateRoutine } = setup({
      updateRoutine: () => new Promise((_resolve, rej) => { reject = rej; }),
    });
    await ready();
    const toggle = screen.getByRole("switch", { name: "Update company context enabled" });
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
    const trigger = screen.getByRole("button", { name: "Update company context" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { hidden: true });
    expect(within(dialog).getByText(/Uses new source material/)).toBeTruthy();

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Close routine details", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
  });

  it("explains toggle-only routines without an editor", async () => {
    setup();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Sync Slack" }));
    const dialog = await screen.findByRole("dialog", { hidden: true });
    expect(within(dialog).getByText(/Timing is managed by Draft/)).toBeTruthy();
    expect(within(dialog).queryByLabelText("Frequency")).toBeNull();
  });

  it("saves a new schedule and warns about hourly cadence", async () => {
    const { updateRoutine } = setup({
      updateRoutine: async (id, patch) => ({ ...routine({ id: "sessions" }), ...("preset" in patch ? { preset: patch.preset } : {}) }) as Routine,
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Summarize coding sessions" }));
    const dialog = await screen.findByRole("dialog", { hidden: true });

    fireEvent.change(within(dialog).getByLabelText("Frequency"), { target: { value: "hourly" } });
    expect(within(dialog).getByRole("status").textContent).toMatch(/processing usage/);

    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalled());
    const [id, patch] = updateRoutine.mock.calls[0]!;
    expect(id).toBe("sessions");
    expect(patch).toMatchObject({ preset: "hourly" });
    await waitFor(() => expect(screen.queryByRole("dialog", { hidden: true })).toBeNull());
  });

  it("keeps Save disabled until something changes", async () => {
    setup();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Summarize coding sessions" }));
    const dialog = await screen.findByRole("dialog", { hidden: true });
    const save = within(dialog).getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "04:15" } });
    expect(save.disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "03:00" } });
    expect(save.disabled).toBe(true);
  });

  it("keeps the dialog open and shows the error beside the field when saving fails", async () => {
    setup({
      updateRoutine: async () => {
        throw Object.assign(new Error("Time must be HH:MM"), { field: "time" });
      },
    });
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "Summarize coding sessions" }));
    const dialog = await screen.findByRole("dialog", { hidden: true });

    fireEvent.change(within(dialog).getByLabelText("Time"), { target: { value: "04:15" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Time must be HH:MM");
    expect(screen.getByRole("dialog", { hidden: true })).toBeTruthy();
  });

  it("shows the empty state", async () => {
    setup({ routines: [] });
    await ready();
    expect(screen.getByText("No routines yet")).toBeTruthy();
  });
});

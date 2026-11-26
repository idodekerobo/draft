import { afterEach, describe, expect, it, mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Suspense } from "react";
import { DraftApiProvider, type DraftApi } from "../query/api";
import { RoutinesPanel } from "./RoutinesPanel";
import { chainSteps, sanitizeStepKey, stepsProblem } from "./StepsEditor";
import type { Routine, RoutineStepEdit, RoutinesResponse } from "./types";

afterEach(cleanup);

const base = (overrides: Partial<Routine>): Routine => ({
  id: "r", taskType: "agent_routine", title: "Weekly digest", routineDescription: "Runs an agent on this schedule.", scheduleDescription: "Daily at 9:00 AM",
  preset: "daily", time: "09:00", weekday: null, timezone: "UTC", cron: null, intervalSeconds: null, enabled: true, editable: "full", connectionLabel: null,
  needsReconnect: false, nextRunAt: "2099-01-01T09:00:00.000Z", lastCheckedAt: null, lastRun: null, updatedByName: null, kind: "recurring", runAt: null, firedAt: null,
  madeByAgent: false, createdByRunId: null, createdBySessionId: null, visibility: "shared", agent: null, ...overrides,
});

const synthesis = (builtIn: Partial<NonNullable<Routine["builtIn"]>> = {}) => base({
  id: "synth", taskType: "synthesize_workspace", title: "Update company context", routineDescription: "Uses new source material to update your company context.",
  preset: "draft_default", time: null, builtIn: { prompt: "Treat pricing as important.", harness: "claude", model: null, ...builtIn },
});

const step = (key: string, prompt: string, overrides: Partial<RoutineStepEdit> = {}): RoutineStepEdit => ({ key, prompt, model: null, fanOut: { over: "none" }, output: { type: "text" }, ...overrides });
const custom = (steps?: RoutineStepEdit[]) => base({ agent: { prompt: "Write the weekly digest.", harness: "claude", model: null, createdByName: "Maya", lastRun: null, ...(steps ? { steps } : {}) } });

function open(routine: Routine, updateRoutine = mock(async () => routine)) {
  const response: RoutinesResponse = { routines: [routine], canEdit: true };
  const api = { getRuns: async () => ({ runs: [], nextCursor: null }), getRoutines: async () => response, updateRoutine, createRoutine: async () => routine, deleteRoutine: async () => {}, getRoutineRuns: async () => [] } as DraftApi;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DraftApiProvider api={api}>
        <Suspense fallback="loading"><RoutinesPanel workspaceId="ws-1" initialOpenId={routine.id} /></Suspense>
      </DraftApiProvider>
    </QueryClientProvider>,
  );
  return { updateRoutine };
}

const dialog = async () => within(await screen.findByRole("dialog"));

describe("the context update routine", () => {
  it("calls its text box Guidance, says what it is for, and does not offer a request or steps to edit", async () => {
    open(synthesis());
    const d = await dialog();
    expect(d.getByLabelText(/^Guidance/)).toBeTruthy();
    expect(d.getByText("Added to every step of a context update. Say what matters to your team.")).toBeTruthy();
    expect(d.queryByText("What should it do?")).toBeNull();
    expect(d.queryByRole("button", { name: "Split into steps" })).toBeNull();
    expect(d.queryByRole("button", { name: "Add a step" })).toBeNull();
  });

  it("lists its three steps, and the small model for capture and the larger one for the rest on Claude", async () => {
    open(synthesis());
    const d = await dialog();
    const steps = d.getByRole("region", { name: "Steps of a context update" });
    const items = within(steps).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".ui-synthesis-steps__name")!.textContent)).toEqual(["Capture uses Haiku", "Reconcile uses Sonnet", "Organize uses Sonnet"]);
    expect(within(steps).getByText("Reads the new sources and notes what matters. Writes nothing.")).toBeTruthy();
    expect(d.getByText("Runs in three steps: capture, reconcile, then organize")).toBeTruthy();
  });

  it("names the Codex models when it runs on Codex, and a chosen model for every step", async () => {
    open(synthesis({ harness: "codex" }));
    const first = await dialog();
    expect(within(first.getByRole("region", { name: "Steps of a context update" })).getAllByRole("listitem").map((item) => item.querySelector(".ui-synthesis-steps__name")!.textContent))
      .toEqual(["Capture uses GPT-6-Luna", "Reconcile uses GPT-6.1 Terra", "Organize uses GPT-6.1 Terra"]);
    cleanup();
    open(synthesis({ model: "opus" }));
    const second = await dialog();
    expect(within(second.getByRole("region", { name: "Steps of a context update" })).getAllByRole("listitem").map((item) => item.querySelector(".ui-synthesis-steps__name")!.textContent))
      .toEqual(["Capture uses Opus", "Reconcile uses Opus", "Organize uses Opus"]);
  });

  it("saves a change to the guidance, and only that, with no steps in the patch", async () => {
    const { updateRoutine } = open(synthesis());
    const d = await dialog();
    fireEvent.change(d.getByLabelText(/^Guidance/), { target: { value: "Always name the customer." } });
    fireEvent.click(d.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledWith("synth", { prompt: "Always name the customer." }));
  });
});

describe("a custom routine's steps", () => {
  it("runs as one agent until it is split, with a way to split it", async () => {
    open(custom());
    const d = await dialog();
    expect(d.getByRole("button", { name: "Split into steps" })).toBeTruthy();
    expect(d.queryByRole("group", { name: "Steps" })).toBeNull();
  });

  it("splits into two steps, the first starting from the routine's own request", async () => {
    open(custom());
    const d = await dialog();
    fireEvent.click(d.getByRole("button", { name: "Split into steps" }));
    const group = d.getByRole("group", { name: "Steps" });
    expect((within(group).getByLabelText("Instructions for step 1, step_1") as HTMLTextAreaElement).value).toBe("Write the weekly digest.");
    expect((within(group).getByLabelText("Instructions for step 2, step_2") as HTMLTextAreaElement).value).toBe("");
    // A step with no instructions cannot be saved, and the page says why.
    expect(within(group).getByRole("alert").textContent).toBe("Step 2 needs instructions.");
    expect((d.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the steps once each has instructions, each reading the one before it", async () => {
    const { updateRoutine } = open(custom());
    const d = await dialog();
    fireEvent.click(d.getByRole("button", { name: "Split into steps" }));
    fireEvent.change(d.getByLabelText("Instructions for step 2, step_2"), { target: { value: "Write the digest from the facts." } });
    fireEvent.change(d.getByLabelText("Name of step 1, step_1"), { target: { value: "Collect Facts" } });
    fireEvent.click(d.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledTimes(1));
    expect(updateRoutine).toHaveBeenCalledWith("r", { steps: [
      { key: "collect_facts", prompt: "Write the weekly digest.", model: null, fanOut: { over: "none" }, output: { type: "text" } },
      { key: "step_2", prompt: "Write the digest from the facts.", model: null, fanOut: { over: "none" }, output: { type: "text" }, inputsFrom: ["collect_facts"] },
    ] });
  });

  it("shows a routine's existing steps, and changing nothing offers no save", async () => {
    open(custom([step("collect", "Collect."), step("write", "Write.", { inputsFrom: ["collect"] })]));
    const d = await dialog();
    expect((d.getByLabelText("Instructions for step 2, write") as HTMLTextAreaElement).value).toBe("Write.");
    expect((d.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reorders, removes and adds steps, and keeps each step reading the one before it", async () => {
    const { updateRoutine } = open(custom([step("collect", "Collect."), step("write", "Write.", { inputsFrom: ["collect"] })]));
    const d = await dialog();
    fireEvent.click(d.getByRole("button", { name: "Move step 2, write up" }));
    fireEvent.click(d.getByRole("button", { name: "Add a step" }));
    fireEvent.change(d.getByLabelText("Instructions for step 3, step_3"), { target: { value: "Check it." } });
    fireEvent.click(d.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledTimes(1));
    const sent = (updateRoutine.mock.calls[0] as unknown as [string, { steps: RoutineStepEdit[] }])[1].steps;
    expect(sent.map((entry) => [entry.key, entry.inputsFrom])).toEqual([["write", undefined], ["collect", ["write"]], ["step_3", ["collect"]]]);
  });

  it("removes a step, and cannot move the first up or the last down", async () => {
    open(custom([step("collect", "Collect."), step("write", "Write.", { inputsFrom: ["collect"] })]));
    const d = await dialog();
    expect((d.getByRole("button", { name: "Move step 1, collect up" }) as HTMLButtonElement).disabled).toBe(true);
    expect((d.getByRole("button", { name: "Move step 2, write down" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(d.getByRole("button", { name: "Remove step 1, collect" }));
    expect(d.queryByLabelText("Instructions for step 2, write")).toBeNull();
    expect((d.getByLabelText("Instructions for step 1, write") as HTMLTextAreaElement).value).toBe("Write.");
  });

  it("sends null when the routine goes back to a single agent", async () => {
    const { updateRoutine } = open(custom([step("collect", "Collect.")]));
    const d = await dialog();
    fireEvent.click(d.getByRole("button", { name: "Go back to a single agent" }));
    fireEvent.click(d.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledWith("r", { steps: null }));
  });

  it("can run a step once for each document", async () => {
    const { updateRoutine } = open(custom([step("check", "Check it.")]));
    const d = await dialog();
    fireEvent.click(d.getByRole("checkbox", { name: "Run once for each document in the company context" }));
    fireEvent.click(d.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledTimes(1));
    const sent = (updateRoutine.mock.calls[0] as unknown as [string, { steps: RoutineStepEdit[] }])[1].steps;
    expect(sent[0]!.fanOut).toEqual({ over: "context_documents", filter: "all_stable" });
  });

  it("stops at ten steps", async () => {
    open(custom(Array.from({ length: 10 }, (_, index) => step(`s${index}`, "Do it."))));
    const d = await dialog();
    expect((d.getByRole("button", { name: "Add a step" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("step helpers", () => {
  it("turn a typed name into a valid key", () => {
    expect(sanitizeStepKey("Collect Facts")).toBe("collect_facts");
    // A space becomes an underscore as it is typed, so a name of several words can be typed word by word.
    expect(sanitizeStepKey("collect ")).toBe("collect_");
    expect(sanitizeStepKey("3 steps!")).toBe("steps");
    expect(sanitizeStepKey("a-b")).toBe("a_b");
    expect(sanitizeStepKey("x".repeat(50))).toHaveLength(32);
    expect(sanitizeStepKey("123")).toBe("");
  });

  it("find the first problem with a list, in words", () => {
    expect(stepsProblem([])).toBeNull();
    expect(stepsProblem([step("a", "Do it.")])).toBeNull();
    expect(stepsProblem([step("", "Do it.")])).toBe("Step 1 needs a name made of letters, numbers and underscores.");
    expect(stepsProblem([step("a", "Do it."), step("a", "Do it.")])).toBe("Two steps are named “a”. Give each its own name.");
    expect(stepsProblem([step("a", "Do it."), step("b", "  ")])).toBe("Step 2 needs instructions.");
  });

  it("make each step read the one before it, and the first read nothing", () => {
    const chained = chainSteps([step("a", "x", { inputsFrom: ["stale"] }), step("b", "y"), step("c", "z")]);
    expect(chained.map((entry) => entry.inputsFrom)).toEqual([undefined, ["a"], ["b"]]);
  });
});

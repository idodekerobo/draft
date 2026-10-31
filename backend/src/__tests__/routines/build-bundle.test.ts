import { describe, expect, it } from "bun:test";
import { buildRoutineBundle, renderRoutinePrompt } from "../../routines/build-bundle";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

it("puts the brain under input/context, keyed to the session's run id", () => {
  const bundle = buildRoutineBundle({
    organizationId: "org", workspaceId: "ws", sessionId: SESSION_ID,
    documents: { "product/index.md": { content: "# Product\n" }, "memory/2026-10.md": { content: "notes" } },
  });
  expect(bundle.runId).toBe(`routine:${SESSION_ID}`);
  expect(Object.keys(bundle.files).sort()).toEqual(["input/context/memory/2026-10.md", "input/context/product/index.md"]);
  expect(bundle.bundleHash).toMatch(/^[0-9a-f]{64}$/);
});

it("drops paths that could leave the context folder", () => {
  const bundle = buildRoutineBundle({
    organizationId: "org", workspaceId: "ws", sessionId: SESSION_ID,
    documents: { "../escape.md": { content: "x" }, "/abs.md": { content: "x" }, "a/../b.md": { content: "x" }, "ok.md": { content: "ok" } },
  });
  expect(Object.keys(bundle.files)).toEqual(["input/context/ok.md"]);
});

it("still builds a bundle for a workspace with no brain yet", () => {
  const bundle = buildRoutineBundle({ organizationId: "org", workspaceId: "ws", sessionId: SESSION_ID, documents: {} });
  expect(Object.keys(bundle.files)).toEqual(["input/context/README.md"]);
});

const promptContext = {
  title: "Weekly digest",
  schedule: "Mondays at 9:00 AM",
  timezone: "America/New_York",
  startedAt: new Date("2026-11-02T14:00:00.000Z"),
};

describe("renderRoutinePrompt", () => {
  it("puts the routine's request after the instructions about where the brain is", () => {
    const prompt = renderRoutinePrompt("  List the risks.  ", promptContext);
    expect(prompt).toContain("/run/input/context");
    expect(prompt.trimEnd().endsWith("List the risks.")).toBe(true);
  });

  it("tells the agent the routine, its schedule and when this run started", () => {
    const prompt = renderRoutinePrompt("Do it.", promptContext);
    expect(prompt).toContain("Routine: Weekly digest");
    expect(prompt).toContain("Schedule: Mondays at 9:00 AM (America/New_York)");
    expect(prompt).toContain("This run started: Monday, November 2, 2026 at 9:00 AM");
  });

  it("says to read the brain as needed and names no tool, so one text fits every agent", () => {
    const prompt = renderRoutinePrompt("Do it.", promptContext);
    expect(prompt).toContain("Read them as needed.");
    for (const tool of ["Glob", "Read tool", "shell", "cat"]) expect(prompt).not.toContain(tool);
  });

  it("falls back to UTC for a timezone it cannot read", () => {
    expect(renderRoutinePrompt("Do it.", { ...promptContext, timezone: "Nope/Nope" })).toContain("2:00 PM UTC");
  });
});

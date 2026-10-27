import { expect, it } from "bun:test";
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

it("puts the routine's request after the instructions about where the brain is", () => {
  const prompt = renderRoutinePrompt("  List the risks.  ");
  expect(prompt).toContain("/run/input/context");
  expect(prompt.trimEnd().endsWith("List the risks.")).toBe(true);
});

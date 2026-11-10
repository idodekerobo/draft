import { describe, expect, it } from "bun:test";
import { parseWorkspaceId } from "draft-core/agent-run";
import { buildRoutineBundle } from "../../../routines/build-bundle";
import { canSeeContextPath, visibleContext } from "../../../metaharness/context/visible-context";

const audience = { type: "system", workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222") } as const;

describe("visibleContext", () => {
  it("shows every document to every audience in the workspace today", () => {
    const documents = { "a.md": { content: "A" }, "b.md": { content: "B" } };
    expect(visibleContext(audience, documents)).toEqual(documents);
    expect(canSeeContextPath(audience, "a.md")).toBe(true);
  });

  it("is the rule the routine bundle follows", () => {
    const bundle = buildRoutineBundle({
      organizationId: "org",
      workspaceId: audience.workspaceId,
      sessionId: "11111111-1111-4111-8111-111111111111",
      audience,
      documents: { "a.md": { content: "A" } },
    });
    expect(Object.keys(bundle.files)).toEqual(["input/context/a.md"]);
  });
});

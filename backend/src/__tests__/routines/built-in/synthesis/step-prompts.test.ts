import { describe, expect, it } from "bun:test";
import { CAPTURE_PERMISSIONS, ORGANIZE_PERMISSIONS, RECONCILE_PERMISSIONS } from "draft-core/tools";
import { DEFAULT_SYNTHESIS_PROMPT } from "../../../../routines/built-in-defaults";
import { parseBuiltInConfig } from "../../../../routines/built-in-config";
import { DEFAULT_SYNTHESIS_GUIDANCE, LEGACY_SYNTHESIS_PROMPT, guidanceOf } from "../../../../routines/built-in/synthesis/guidance";
import { CAPTURE_PROMPT, ORGANIZE_PROMPT, RECONCILE_NEW_DOCUMENTS_PROMPT, RECONCILE_PROMPT, stepPrompt } from "../../../../routines/built-in/synthesis/steps/prompts";

describe("the team's guidance", () => {
  it("is added to the prompt of every step", () => {
    for (const key of ["capture", "reconcile", "organize"] as const) {
      const prompt = stepPrompt(key, "Always name the customer.");
      expect(prompt).toContain("## The team's guidance");
      expect(prompt).toContain("Always name the customer.");
    }
  });

  it("adds nothing when the guidance is empty", () => {
    expect(stepPrompt("capture", "   ")).not.toContain("guidance");
    expect(stepPrompt("capture", "")).toBe(`${CAPTURE_PROMPT}\n`);
  });

  it("keeps a team's own text, and replaces the old one-agent prompt and an empty value with the default", () => {
    expect(guidanceOf("Always name the customer.")).toBe("Always name the customer.");
    expect(guidanceOf(LEGACY_SYNTHESIS_PROMPT)).toBe(DEFAULT_SYNTHESIS_GUIDANCE);
    expect(guidanceOf(`${LEGACY_SYNTHESIS_PROMPT}\n`)).toBe(DEFAULT_SYNTHESIS_GUIDANCE);
    expect(guidanceOf("  ")).toBe(DEFAULT_SYNTHESIS_GUIDANCE);
  });

  it("is what a workspace gets in its built-in synthesis settings, even when it saved the old prompt", () => {
    expect(DEFAULT_SYNTHESIS_PROMPT).toBe(DEFAULT_SYNTHESIS_GUIDANCE);
    expect(parseBuiltInConfig("synthesize_workspace", {}).prompt).toBe(DEFAULT_SYNTHESIS_GUIDANCE);
    expect(parseBuiltInConfig("synthesize_workspace", { prompt: LEGACY_SYNTHESIS_PROMPT }).prompt).toBe(DEFAULT_SYNTHESIS_GUIDANCE);
    expect(parseBuiltInConfig("synthesize_workspace", { prompt: "Custom." }).prompt).toBe("Custom.");
  });

  it("does not carry the old instruction to keep everything that is still valid", () => {
    expect(DEFAULT_SYNTHESIS_GUIDANCE).not.toContain("Preserve all still-valid context");
    for (const prompt of [CAPTURE_PROMPT, RECONCILE_PROMPT, RECONCILE_NEW_DOCUMENTS_PROMPT, ORGANIZE_PROMPT]) expect(prompt).not.toContain("Preserve all still-valid context");
  });
});

describe("the step prompts agree with each step's tools", () => {
  const has = (permissions: ReadonlyArray<{ tool: string }>, tool: string) => permissions.some((permission) => permission.tool === tool);

  it("tell capture to write nothing, and do not ask it to use a tool it lacks", () => {
    expect(CAPTURE_PROMPT).toContain("You write nothing");
    expect(has(CAPTURE_PERMISSIONS, "context.write")).toBe(false);
    expect(CAPTURE_PROMPT).not.toContain("context.write");
    expect(has(CAPTURE_PERMISSIONS, "sources.read")).toBe(true);
    expect(CAPTURE_PROMPT).toContain("sources.read");
  });

  it("ask reconcile to prove changes from sources and to check the document's history, with the tools to do both", () => {
    expect(RECONCILE_PROMPT).toContain("sources.read");
    expect(RECONCILE_PROMPT).toContain("`history`");
    expect(RECONCILE_PROMPT).toContain("Never rewrite a document from the entries or from memory alone");
    expect(RECONCILE_PROMPT).toContain("does the evidence change what this document says is true now?");
    expect(has(RECONCILE_PERMISSIONS, "context.write") && has(RECONCILE_PERMISSIONS, "sources.read") && has(RECONCILE_PERMISSIONS, "context.read")).toBe(true);
  });

  it("send a conflict the sources cannot settle to organize, not to a pick of one side", () => {
    expect(RECONCILE_PROMPT).toContain("do not pick one");
    expect(RECONCILE_PROMPT).toContain("`conflicts`");
    expect(ORGANIZE_PROMPT).toContain("CONFLICT (<date>)");
    expect(ORGANIZE_PROMPT).toContain("`needs_input`");
  });

  it("never ask any step to send a message, which no step may do", () => {
    for (const prompt of [CAPTURE_PROMPT, RECONCILE_PROMPT, RECONCILE_NEW_DOCUMENTS_PROMPT, ORGANIZE_PROMPT]) expect(prompt).not.toContain("people.notify");
    expect(has(ORGANIZE_PERMISSIONS, "people.notify")).toBe(false);
  });

  it("give the people rules to organize only, which is the one step with the people tools", () => {
    expect(ORGANIZE_PROMPT).toContain("people.find");
    for (const prompt of [CAPTURE_PROMPT, RECONCILE_PROMPT]) expect(prompt).not.toContain("people.find");
    expect(has(CAPTURE_PERMISSIONS, "people.find") || has(RECONCILE_PERMISSIONS, "people.find")).toBe(false);
  });

  it("ask capture for the answer shape the step's schema has", () => {
    expect(CAPTURE_PROMPT).toContain('"entries"');
    for (const field of ["period", "text", "source_item_ids", "affects"]) expect(CAPTURE_PROMPT).toContain(field);
    for (const field of ["summary", "changed", "conflicts"]) expect(RECONCILE_PROMPT).toContain(field);
    for (const field of ["outcome", "summary", "needs_input"]) expect(ORGANIZE_PROMPT).toContain(field);
  });
});

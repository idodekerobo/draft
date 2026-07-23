import { describe, expect, it } from "bun:test";
import { validateAutomatedSynthesisOutput } from "../proposals";

function output(file: string, action: string): string {
  return `---
context_updates:
  - file: ${file}
    action: ${action}
    content: |
      Durable product context.
---
Summary
`;
}

describe("automated synthesis output validation", () => {
  it("accepts routed append and tension actions", () => {
    expect(validateAutomatedSynthesisOutput(output("context/product/index.md", "append")).ok).toBe(true);
    expect(validateAutomatedSynthesisOutput(output("context/tensions.md", "tension")).ok).toBe(true);
  });

  it("rejects overwrite and unknown automated actions", () => {
    expect(validateAutomatedSynthesisOutput(output("context/product/index.md", "overwrite")))
      .toEqual({ ok: false, error: 'automated action "overwrite" is not allowed' });
    expect(validateAutomatedSynthesisOutput(output("context/product/index.md", "delete")).ok).toBe(false);
  });

  it("rejects traversal and action/path mismatches", () => {
    expect(validateAutomatedSynthesisOutput(output("context/../secrets.json", "append")).ok).toBe(false);
    expect(validateAutomatedSynthesisOutput(output("context/tensions.md", "append")).ok).toBe(false);
    expect(validateAutomatedSynthesisOutput(output("context/product/index.md", "tension")).ok).toBe(false);
  });

  it("requires a parseable frontmatter schema", () => {
    expect(validateAutomatedSynthesisOutput("not yaml").ok).toBe(false);
    expect(validateAutomatedSynthesisOutput("---\ncontext_updates: nope\n---\n").ok).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { buildSummarizationPrompt, summarizationJsonSchema } from "../../summarization/render-prompt";

describe("buildSummarizationPrompt", () => {
  test("inlines the transcript directly into the prompt", () => {
    const prompt = buildSummarizationPrompt("USER: fix the bug\nASSISTANT: done");
    expect(prompt).toContain("USER: fix the bug\nASSISTANT: done");
    expect(prompt).toContain("output/result.json");
  });
});

test("summarizationJsonSchema requires all four summary fields", () => {
  const schema = summarizationJsonSchema() as { required: string[] };
  expect(schema.required).toEqual(["who", "project", "outcome", "keyDecisions"]);
});

import { describe, expect, it } from "bun:test";
import { codexArgs, codexRunner, completedCodexResult } from "../harnesses/codex/runner";
import type { RunnerManifest } from "../run-manifest";

const manifest: RunnerManifest = {
  version: 1, harness: "codex", model: "gpt-6-luna", reasoningEffort: "high",
  prompt: { kind: "file", path: "/run/input/prompt.md" },
  tools: { native: ["shell"], draftMcpUrl: null },
  output: { kind: "structured", schemaPath: "/run/input/output-schema.json" },
  network: "restricted", timeoutSeconds: 1200,
};
const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n");
const answer = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });

describe("Codex structured output", () => {
  it("uses the shared schema, saved model and reasoning, and the bundle's working directory", () => {
    expect(codexArgs(manifest)).toContain("--output-schema");
    expect(codexArgs(manifest)).toContain(manifest.output.kind === "structured" ? manifest.output.schemaPath : "");
    const command = codexRunner.command(manifest, "Read input/sources", "{}", {});
    expect(command.cwd).toBe("/run");
    expect(command.stdin).toBe("Read input/sources");
    expect(command.argv).toContain("gpt-6-luna");
    expect(command.argv).toContain('model_reasoning_effort="high"');
  });

  it("waits for a completed turn, ignores tool results, and parses only its final answer", () => {
    const text = lines({ type: "item.completed", item: { type: "command_execution", aggregated_output: '{"wrong":true}' } }, answer('{"outcome":"no_change"}'));
    expect(completedCodexResult(text)).toBeNull();
    expect(completedCodexResult(`${text}\n${lines({ type: "turn.completed" })}`)).toEqual({ is_error: false, result: { outcome: "no_change" } });
  });

  it("rejects malformed JSON and reports failed turns", () => {
    expect(codexRunner.structured!.payload(completedCodexResult(lines(answer("not json"), { type: "turn.completed" })))).toBeNull();
    expect(completedCodexResult(lines({ type: "turn.failed", error: { message: "failed" } }))?.is_error).toBe(true);
    expect(completedCodexResult(lines(answer('{"earlier":true}'), answer("not json"), { type: "turn.completed" }))?.result).toBeNull();
  });
});

import { describe, expect, it } from "bun:test";
import { buildRoutineRunSpec } from "../../routines/run-spec";
import { loadRunnerManifest, validateRunnerManifest } from "../../sandbox/claude-code/runner";
import { buildRunnerManifest, legacyRunnerEnv, needsDraftToolServer, runnerManifestSchema } from "../../sandbox/run-manifest";
import { buildSummarizationRunSpec } from "../../summarization/run-spec";
import { buildSynthesisRunSpec } from "../../synthesis/run-spec";

const WS = "22222222-2222-4222-8222-222222222222";
const RUN = "11111111-1111-4111-8111-111111111111";
const TASK = "55555555-5555-4555-8555-555555555555";
const VERSION = "44444444-4444-4444-8444-444444444444";
const CALLBACK = "https://api.example.test/sandbox/callback";
const MCP_URL = `https://api.example.test/runs/${RUN}/mcp`;
const schema = { type: "object" };
const when = "2026-11-09T03:00:00.000Z";

const routine = (harness: "claude" | "codex", nativeTools: string[] = []) =>
  buildRoutineRunSpec({
    id: RUN, workspaceId: WS, scheduledTaskId: TASK, occurrenceAt: when,
    routine: { title: "t", prompt: "p", harness, model: harness === "claude" ? "haiku" : null, environment: { nativeTools, mcpServers: [] } },
    contextVersionId: VERSION,
  });

const cases = [
  { name: "synthesis", spec: buildSynthesisRunSpec({ runId: RUN, workspaceId: WS, triggerType: "manual", contextVersionId: VERSION, resultSchema: schema }), prompt: { kind: "text" as const, text: "p" } },
  { name: "summarization", spec: buildSummarizationRunSpec({ id: RUN, workspaceId: WS, scheduledTaskId: TASK, occurrenceAt: when, contextVersionId: VERSION, resultSchema: schema }), prompt: { kind: "items" as const, manifestPath: "input/manifest.json" } },
  { name: "Claude routine", spec: routine("claude", ["WebSearch"]), prompt: { kind: "text" as const, text: "p" } },
  { name: "Codex routine", spec: routine("codex", ["web_search"]), prompt: { kind: "text" as const, text: "p" } },
];

describe("the backend's manifest and the runner's parser agree", () => {
  for (const { name, spec, prompt } of cases) {
    it(`${name}: the runner accepts what the backend builds`, () => {
      const manifest = buildRunnerManifest({ spec, prompt, timeoutSeconds: 900, draftMcpUrl: needsDraftToolServer(spec) ? MCP_URL : null });
      expect(validateRunnerManifest(JSON.parse(JSON.stringify(manifest)), CALLBACK)).toEqual(manifest);
      expect(runnerManifestSchema.parse(manifest)).toEqual(manifest);
    });

    it(`${name}: the older environment variables give the same manifest`, () => {
      const manifest = buildRunnerManifest({ spec, prompt, timeoutSeconds: 900, draftMcpUrl: needsDraftToolServer(spec) ? MCP_URL : null });
      const fromLegacy = loadRunnerManifest({ ...legacyRunnerEnv(manifest), DRAFT_TIMEOUT_SECONDS: "900" }, CALLBACK);
      expect(fromLegacy).toEqual(manifest);
    });
  }
});

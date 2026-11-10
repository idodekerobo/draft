import { describe, expect, it } from "bun:test";
import { buildRoutineRunSpec } from "../../routines/run-spec";
import { loadRunnerManifest } from "../../sandbox/runner/manifest";
import { validateRunnerManifest } from "draft-core/run-manifest";
import { buildRunnerManifest, legacyRunnerEnv, needsDraftToolServer } from "../../sandbox/run-manifest";
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

describe("the manifest the backend builds, for every kind of run", () => {
  for (const { name, spec, prompt } of cases) {
    it(`${name}: passes the shared validator after a JSON round trip`, () => {
      const manifest = buildRunnerManifest({ spec, callbackUrl: CALLBACK, prompt, timeoutSeconds: 900, draftMcpUrl: needsDraftToolServer(spec) ? MCP_URL : null });
      expect(validateRunnerManifest(JSON.parse(JSON.stringify(manifest)), { callbackUrl: CALLBACK })).toEqual(manifest);
    });

    it(`${name}: the older environment variables give the same manifest`, () => {
      const manifest = buildRunnerManifest({ spec, callbackUrl: CALLBACK, prompt, timeoutSeconds: 900, draftMcpUrl: needsDraftToolServer(spec) ? MCP_URL : null });
      const fromLegacy = loadRunnerManifest({ ...legacyRunnerEnv(manifest), DRAFT_TIMEOUT_SECONDS: "900" }, CALLBACK);
      expect(fromLegacy).toEqual(manifest);
    });
  }
});

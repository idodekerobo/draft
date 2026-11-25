import type { SupabaseClient } from "@supabase/supabase-js";
import { createInitialWorkspaceSynthesis } from "../../synthesis/register-workspace-synthesis";
import { registerSessionSummaryTask } from "../../summarization/register-session-summaries";
import { describe, expect, it } from "bun:test";
import { defaultBuiltInConfig, loadBuiltInConfig, parseBuiltInConfig } from "../../routines/built-in-config";
import { validatePatch } from "../../routines/validate-patch";
import { buildSummarizationRunSpec } from "../../summarization/run-spec";
import { buildSynthesisRunSpec } from "../../synthesis/run-spec";
import { buildSummarizationPrompt } from "../../summarization/render-prompt";
import { fakeClient, fakeDb } from "./fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const VERSION = "44444444-4444-4444-8444-444444444444";
const TASK = "55555555-5555-4555-8555-555555555555";

describe("built-in routine settings", () => {
  it("initializes an existing task from code once and reads subsequent team customizations", async () => {
    const db = fakeDb({ scheduled_tasks: [{ id: TASK, workspace_id: WS, task_type: "summarize_sessions", config_json: {} }] });
    const client = fakeClient(db);
    expect(await loadBuiltInConfig(client, WS, "summarize_sessions")).toEqual(defaultBuiltInConfig("summarize_sessions"));
    expect(db.tables.scheduled_tasks![0]!.config_json).toEqual(defaultBuiltInConfig("summarize_sessions"));
    const saved = { harness: "codex" as const, model: "gpt-6-luna", prompt: "Focus on decisions.", reasoningEffort: "high" };
    db.tables.scheduled_tasks![0]!.config_json = saved;
    expect(await loadBuiltInConfig(client, WS, "summarize_sessions")).toEqual(saved);
  });

  it("lets a concurrent team edit win over default initialization", async () => {
    const defaults = { id: TASK, workspace_id: WS, task_type: "synthesize_workspace", config_json: {}, updated_at: "before" };
    const customized = { harness: "codex" as const, model: "gpt-6-luna", prompt: "A teammate saved this." };
    const db = fakeDb({ scheduled_tasks: [defaults] });
    const real = fakeClient(db);
    let queries = 0;
    const client = { from: (table: string) => {
      if (table === "scheduled_tasks" && ++queries === 2) db.tables.scheduled_tasks![0] = { ...defaults, config_json: customized, updated_at: "after" };
      return real.from(table);
    } } as SupabaseClient;
    expect(await loadBuiltInConfig(client, WS, "synthesize_workspace")).toEqual(customized);
    expect(db.tables.scheduled_tasks![0]!.config_json).toEqual(customized);
  });

  it("registers defaults once and preserves customizations on subsequent registration", async () => {
    const db = fakeDb({ workspaces: [{ id: WS, timezone: "UTC" }] });
    const client = fakeClient(db);
    for (const register of [() => createInitialWorkspaceSynthesis({ id: WS }, client), () => registerSessionSummaryTask(WS, client)]) {
      await register();
      const row = db.tables.scheduled_tasks!.at(-1)!;
      expect(row.config_json).toEqual(defaultBuiltInConfig(String(row.task_type)));
      row.config_json = { ...defaultBuiltInConfig(String(row.task_type)), prompt: "Custom instructions." };
      await register();
      expect(row.config_json).toMatchObject({ prompt: "Custom instructions." });
    }
    expect(db.tables.scheduled_tasks).toHaveLength(2);
  });

  it("validates harness-specific models, clears stale model and effort on a harness change", () => {
    const current = { ...defaultBuiltInConfig("synthesize_workspace"), model: "haiku", reasoningEffort: "high" };
    const changed = validatePatch({ harness: "codex" }, "full", null, current);
    expect(changed).toMatchObject({ ok: true, patch: { builtIn: { harness: "codex", model: null } } });
    if (changed.ok) expect(changed.patch.builtIn?.reasoningEffort).toBeUndefined();
    expect(validatePatch({ model: "not-a-model" }, "full", null, current)).toMatchObject({ ok: false, field: "model" });
    expect(() => parseBuiltInConfig("summarize_sessions", { prompt: "" })).toThrow("prompt");
  });

  it("snapshots the selected settings and derives each harness's cloud tools for both run kinds", () => {
    const settings = { harness: "codex" as const, model: "gpt-6-luna", prompt: "Focus on decisions.", reasoningEffort: "high" };
    const common = { workspaceId: WS, scheduledTaskId: TASK, occurrenceAt: "2026-11-23T03:00:00.000Z", contextVersionId: VERSION, resultSchema: {}, settings };
    for (const spec of [buildSynthesisRunSpec({ ...common, runId: RUN, triggerType: "schedule" }), buildSummarizationRunSpec({ ...common, id: RUN })]) {
      expect(spec).toMatchObject({ harness: "codex", model: settings.model, instructions: settings.prompt, reasoningEffort: "high", onBehalfOf: null });
      expect(spec.toolset.nativeTools.every((tool) => tool.harness === "codex")).toBe(true);
    }
    expect(buildSummarizationPrompt("transcript", settings.prompt)).toContain(settings.prompt);
    expect(buildSummarizationPrompt("transcript", settings.prompt)).toContain('"keyDecisions"');
  });
});

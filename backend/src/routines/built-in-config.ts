import type { SupabaseClient } from "@supabase/supabase-js";
import type { HarnessId } from "draft-core/harnesses";
import { validateAgentRoutineConfig } from "./config";
import { guidanceOf } from "./built-in/synthesis/guidance";
import { DEFAULT_SUMMARIZATION_PROMPT, DEFAULT_SYNTHESIS_PROMPT } from "./built-in-defaults";

export interface BuiltInRoutineConfig {
  prompt: string;
  harness: HarnessId;
  model: string | null;
  reasoningEffort?: string;
}

export function isConfigurableBuiltIn(taskType: string): boolean {
  return taskType === "synthesize_workspace" || taskType === "summarize_sessions";
}

export function defaultBuiltInConfig(taskType: string): BuiltInRoutineConfig {
  if (!isConfigurableBuiltIn(taskType)) throw new Error(`No agent settings for ${taskType}`);
  return { prompt: taskType === "synthesize_workspace" ? DEFAULT_SYNTHESIS_PROMPT : DEFAULT_SUMMARIZATION_PROMPT, harness: "claude", model: null };
}

export function parseBuiltInConfig(taskType: string, value: unknown): BuiltInRoutineConfig {
  const stored = value && typeof value === "object" ? value : {};
  const checked = validateAgentRoutineConfig({ ...defaultBuiltInConfig(taskType), ...stored, title: "Built-in routine" });
  if (!checked.ok) throw new Error(`Invalid ${taskType} setting: ${checked.field}`);
  const { prompt, harness, model, reasoningEffort } = checked.config;
  // A workspace that still has the old one-agent prompt gets the new guidance. That prompt told the agent to keep everything.
  return { prompt: taskType === "synthesize_workspace" ? guidanceOf(prompt) : prompt, harness, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export async function loadBuiltInConfig(client: SupabaseClient, workspaceId: string, taskType: string): Promise<BuiltInRoutineConfig> {
  const { data, error } = await client.from("scheduled_tasks").select("id, config_json, updated_at")
    .eq("workspace_id", workspaceId).eq("task_type", taskType).is("deleted_at", null).maybeSingle();
  if (error) throw error;
  const settings = parseBuiltInConfig(taskType, data?.config_json);
  if (data && !Object.hasOwn(data.config_json ?? {}, "prompt")) {
    // A concurrent edit wins over initialization.
    const { data: initialized, error: writeError } = await client.from("scheduled_tasks")
      .update({ config_json: { ...data.config_json, ...settings } }).eq("id", data.id).eq("workspace_id", workspaceId)
      .eq("updated_at", data.updated_at).select("config_json").maybeSingle();
    if (writeError) throw writeError;
    if (!initialized) return loadBuiltInConfig(client, workspaceId, taskType);
    return parseBuiltInConfig(taskType, initialized.config_json);
  }
  return settings;
}

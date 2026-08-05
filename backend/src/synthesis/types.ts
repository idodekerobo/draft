import type { SupabaseClient } from "@supabase/supabase-js";
import type { SandboxDeploymentConfig } from "../sandbox";
import type { SynthesisRunTriggerType } from "../types/enums";

// Mirrors the frozen structured result contract (Plan 0037, "Structured result contract").
export interface SynthesisResultNeedsInputItem {
  question: string;
  current_claim: string;
  new_claim: string;
  reason: string;
  evidence: Array<{ source_item_id: string; excerpt: string }>;
}

export interface SynthesisResultPayload {
  outcome: "changed" | "no_change";
  summary: string;
  documents: Record<string, string>;
  needs_input?: SynthesisResultNeedsInputItem[];
}

export interface ValidatedSynthesisResult {
  runId: string;
  bundleHash: string;
  payload: SynthesisResultPayload;
}

export interface LaunchSynthesisRunOptions {
  workspaceId: string;
  triggerType: SynthesisRunTriggerType;
  /** Ordered source items to include, already fetched and normalized. */
  sourceItemIds: string[];
  scheduledTaskId?: string;
  config: SandboxDeploymentConfig;
  client?: SupabaseClient;
}

export interface LaunchSynthesisRunResult {
  runId: string;
  machineId: string;
  bundleHash: string;
}

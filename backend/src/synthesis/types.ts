import type { SupabaseClient } from "@supabase/supabase-js";
import type { SandboxDeploymentConfig } from "../sandbox";
import type { SynthesisRunTriggerType } from "../types/enums";

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
  /**
   * Source items to include, already fetched and normalized, in the order
   * the synthesis agent should read them (becomes file position 0000, 0001,
   * ... in the run bundle). For providers with multiple items covering the
   * same source over time — e.g. Slack's per-channel message batches —
   * callers must sort oldest-first per channel so the agent sees each
   * channel's history in chronological order.
   */
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

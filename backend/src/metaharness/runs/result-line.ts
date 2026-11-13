import type { SupabaseClient } from "@supabase/supabase-js";

interface ActionCall {
  agent_run_id: string;
  tool_name: string;
  status: string;
  arguments: Record<string, unknown>;
  result_summary: string | null;
}

export function runResultLine(calls: ReadonlyArray<ActionCall>): string | null {
  const channels = new Set<string>();
  const people = new Set<string>();
  const documents = new Set<string>();
  for (const call of calls) {
    if (call.status !== "ok") continue;
    if (call.tool_name === "slack.post_message") {
      const channel = call.result_summary?.match(/^Posted in (#[^\s·]+)/)?.[1];
      if (channel) channels.add(channel);
    }
    if (call.tool_name === "people.notify" && /(?:^|, )slack: sent(?:,|$)/.test(call.result_summary ?? "")) {
      if (typeof call.arguments.personId === "string") people.add(call.arguments.personId);
    }
    if (call.tool_name === "context.write" && call.result_summary?.startsWith("wrote ")) {
      for (const path of call.result_summary.slice(6).split(", ")) documents.add(path);
    }
  }
  const parts = [
    channels.size ? `Posted in ${[...channels].join(", ")}` : null,
    people.size ? `DM'd ${people.size} ${people.size === 1 ? "person" : "people"}` : null,
    documents.size ? `Updated ${documents.size} ${documents.size === 1 ? "doc" : "docs"}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export async function loadRunResults(
  client: SupabaseClient,
  workspaceId: string,
  runs: ReadonlyArray<{ id: string; summary: string | null }>,
): Promise<Map<string, string | null>> {
  if (!runs.length) return new Map();
  const { data, error } = await client.from("agent_run_tool_calls")
    .select("agent_run_id, tool_name, status, arguments, result_summary")
    .eq("workspace_id", workspaceId).in("agent_run_id", runs.map((run) => run.id))
    .eq("status", "ok").in("tool_name", ["slack.post_message", "people.notify", "context.write"]);
  if (error) throw error;
  const grouped = new Map<string, ActionCall[]>();
  for (const call of (data ?? []) as ActionCall[]) {
    const rows = grouped.get(call.agent_run_id) ?? [];
    rows.push(call);
    grouped.set(call.agent_run_id, rows);
  }
  return new Map(runs.map((run) => [run.id, runResultLine(grouped.get(run.id) ?? []) ?? run.summary]));
}

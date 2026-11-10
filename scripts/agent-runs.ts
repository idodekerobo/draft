// Staging helper for agent runs. There is no screen for these yet.
//
//   bun --env-file=.env.staging run scripts/agent-runs.ts runs --workspace <id> [--limit 10]
//   bun --env-file=.env.staging run scripts/agent-runs.ts connect-mcp --workspace <id> --url <https url> --token <token> --name <name> [--user <user id>] [--allow-local]
//   bun --env-file=.env.staging run scripts/agent-runs.ts set-environment --task <scheduled task id> [--native WebSearch,Grep] [--mcp <connection id>[:tool,tool]]...
//
// It writes data, so it refuses to run against the production project.

import { serviceClient as db } from "../backend/src/db/client";
import { createMcpConnection } from "../backend/src/metaharness/tools/remote-mcp";
import { parseAgentRoutineConfig, validateAgentRoutineConfig } from "../backend/src/routines/config";

const PRODUCTION_PROJECT_REF = "rffmhfqlkzkgkkzkxlly";
if ((process.env.SUPABASE_URL ?? "").includes(PRODUCTION_PROJECT_REF)) {
  console.error("This script writes data and will not run against production. Pass the staging env file.");
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);

function flags(args: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const next = args[i + 1];
    const value = next === undefined || next.startsWith("--") ? "true" : args[++i]!;
    found.set(arg.slice(2), [...(found.get(arg.slice(2)) ?? []), value]);
  }
  return found;
}

function need(options: Map<string, string[]>, name: string): string {
  const value = options.get(name)?.[0];
  if (!value) {
    console.error(`Missing --${name}`);
    process.exit(2);
  }
  return value;
}

const options = flags(rest);

if (command === "runs") {
  const workspaceId = need(options, "workspace");
  const limit = Number(options.get("limit")?.[0] ?? 10);
  const { data: runs, error } = await db
    .from("agent_runs")
    .select("id, kind, harness, status, trigger, started_at, completed_at, failure_code, failure_detail, summary, sandbox_machine_id, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  for (const run of runs ?? []) {
    const seconds = run.started_at && run.completed_at ? Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 1000) : null;
    const { data: calls } = await db.from("agent_run_tool_calls").select("tool_name, status").eq("agent_run_id", run.id);
    const byStatus = (calls ?? []).reduce<Record<string, number>>((acc, call) => ({ ...acc, [call.status]: (acc[call.status] ?? 0) + 1 }), {});
    console.log(
      `${run.created_at}  ${run.kind.padEnd(13)} ${run.harness.padEnd(6)} ${run.status.padEnd(10)} ${seconds === null ? "-" : `${seconds}s`.padEnd(6)} tools=${JSON.stringify(byStatus)} ${run.failure_code ?? ""} ${run.summary ?? ""}\n  ${run.id}  trigger=${JSON.stringify(run.trigger)}`,
    );
  }
  if (!runs?.length) console.log("No agent runs in this workspace.");
} else if (command === "connect-mcp") {
  const result = await createMcpConnection(
    db,
    {
      workspaceId: need(options, "workspace"),
      userId: options.get("user")?.[0] ?? null,
      url: need(options, "url"),
      token: need(options, "token"),
      displayName: need(options, "name"),
    },
    { allowLocal: options.has("allow-local") },
  );
  console.log(`Connected. connection id: ${result.connectionId}`);
  console.log(`Tools: ${result.tools.map((tool) => tool.name).join(", ") || "(none)"}`);
} else if (command === "set-environment") {
  const taskId = need(options, "task");
  const { data: task, error } = await db.from("scheduled_tasks").select("id, task_type, config_json").eq("id", taskId).single();
  if (error) throw error;
  if (task.task_type !== "agent_routine") throw new Error("That task is not an agent routine");
  const current = parseAgentRoutineConfig(task.config_json);
  if (!current) throw new Error("That routine's config is not valid");

  const mcpServers = (options.get("mcp") ?? []).map((spec) => {
    const [connectionId, tools] = spec.split(":");
    return { connectionId: connectionId!, tools: tools ? tools.split(",") : ("all" as const) };
  });
  const nativeTools = (options.get("native")?.[0] ?? "").split(",").filter(Boolean);
  const checked = validateAgentRoutineConfig({ ...current, environment: { nativeTools, mcpServers } });
  if (!checked.ok) {
    console.error(`Not valid: ${checked.field}`);
    process.exit(1);
  }
  const { error: updateError } = await db.from("scheduled_tasks").update({ config_json: checked.config }).eq("id", taskId);
  if (updateError) throw updateError;
  console.log("Saved:", JSON.stringify(checked.config.environment));
} else {
  console.error("Commands: runs | connect-mcp | set-environment (see the top of this file)");
  process.exit(2);
}
process.exit(0);

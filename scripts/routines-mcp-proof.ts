// Drives routines and connections through Draft's MCP server the way an outside agent would, against staging:
//   bun --env-file=.env.staging run scripts/routines-mcp-proof.ts --user <user id> [--skip-run]
// It creates and deletes a routine and leaves one unused connect link that expires in 15 minutes.
// It writes data, so it refuses to run against the production project.
import { createMcpHandler } from "../backend/node_modules/@modelcontextprotocol/server";
import { buildMcpServer } from "../backend/src/mcp/tools";
import { serviceClient } from "../backend/src/db/client";
import { findConnectRequest } from "../backend/src/integrations/service";

const PRODUCTION_PROJECT_REF = "rffmhfqlkzkgkkzkxlly";
if ((process.env.SUPABASE_URL ?? "").includes(PRODUCTION_PROJECT_REF)) {
  console.error("This script writes data and will not run against production. Pass the staging env file.");
  process.exit(1);
}

const args = process.argv.slice(2);
const userId = args[args.indexOf("--user") + 1];
const skipRun = args.includes("--skip-run");
if (!userId || args.indexOf("--user") === -1) {
  console.error("usage: bun --env-file=.env.staging run scripts/routines-mcp-proof.ts --user <user id> [--skip-run]");
  process.exit(2);
}

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

let id = 0;
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const handler = createMcpHandler(() => buildMcpServer(userId!, ["read", "write"]));
  const response = await handler.fetch(new Request("http://proof.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  }));
  const text = await response.text();
  const line = text.split("\n").find((item) => item.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : text).result as { isError?: boolean; content: Array<{ text: string }>; tools?: Array<{ name: string }> };
}
async function call<T = Record<string, unknown>>(name: string, input: Record<string, unknown> = {}): Promise<{ ok: boolean; body: T; text: string }> {
  const result = await rpc("tools/call", { name, arguments: input });
  const text = result.content?.[0]?.text ?? "";
  let body = {} as T;
  try { body = JSON.parse(text) as T; } catch { /* a refusal is plain text */ }
  return { ok: !result.isError, body, text };
}

type Integration = { provider: string; status: string; triggers: Array<{ event: string }> };
type Routine = { id: string; title: string; enabled: boolean; agent: { prompt: string; events?: string[]; onSchedule?: false; missingConnections: string[] } };
type Run = { id: string; status: string; startedBy: { type: string }; result: string | null; skipReason?: string | null };

// 1. Discover.
const listed = await rpc("tools/list");
const names = (listed.tools ?? []).map((tool) => tool.name);
check("the MCP offers the routine, connection and activity tools", ["routines.options", "routines.runs", "integrations.list", "integrations.connect", "activity.list"].every((name) => names.includes(name)), `${names.length} tools`);

const activity = await call<{ runs: Array<{ id: string }>; nextCursor: string | null }>("activity.list");
check("activity.list returns the workspace's runs with a cursor for older ones", activity.ok && Array.isArray(activity.body.runs) && "nextCursor" in activity.body, `${activity.body.runs?.length} runs, nextCursor ${activity.body.nextCursor ?? "none"}`);
const badCursor = await call("activity.list", { cursor: "nope" });
check("activity.list refuses a cursor it didn't hand out", !badCursor.ok && badCursor.text.includes("invalid_cursor"));

const integrations = (await call<{ integrations: Integration[] }>("integrations.list")).body.integrations ?? [];
check("integrations.list returns every provider", integrations.length === 6, integrations.map((item) => `${item.provider}:${item.status}`).join(" "));
const missing = integrations.find((item) => item.status !== "connected" && item.triggers.length > 0);
const connected = integrations.find((item) => item.status === "connected" && item.triggers.length > 0);

const options = await call<{ triggers: Array<{ event: string; connected: boolean }>; agents: Array<{ harness: string; status: string }> }>("routines.options");
check("routines.options lists triggers and agents", options.ok && options.body.triggers.length > 0, `agents: ${options.body.agents?.map((agent) => `${agent.harness}:${agent.status}`).join(" ")}`);

// Like an agent would: pick an agent that can run, from routines.options.
const harness = options.body.agents?.find((agent) => agent.status === "connected")?.harness ?? "claude";
const base = { prompt: "Reply with the single word: ok.", harness, schedule: { preset: "daily", time: "09:00", timezone: "UTC" }, onSchedule: false };

// 2. A trigger on a provider that isn't connected is refused, and the agent can get a connect link instead.
if (missing) {
  const refused = await call("routines.create", { ...base, title: "Proof: missing connection", events: [missing.triggers[0]!.event] });
  check(`creating a ${missing.provider} trigger is refused while ${missing.provider} is not connected`, !refused.ok && refused.text.includes(`${missing.provider}_not_connected`), refused.text);
  const link = await call<{ status: string; url: string }>("integrations.connect", { provider: missing.provider });
  check("integrations.connect answers with a link for the person", link.ok && link.body.status === "action_required" && link.body.url.includes("/connect/"));
  const token = link.body.url?.split("/connect/")[1] ?? "";
  check("the link works for the person who asked", (await findConnectRequest(serviceClient, token, userId)).ok);
  check("the link does not work for anyone else", !(await findConnectRequest(serviceClient, token, "00000000-0000-4000-8000-000000000000")).ok);
} else {
  console.log("SKIP every provider with triggers is connected, so the missing-connection path can't be shown");
}

// 3. Create, read, edit, run, read the run, delete.
const created = await call<{ routine: Routine }>("routines.create", { ...base, title: "Proof: MCP routine", ...(connected ? { events: [connected.triggers[0]!.event] } : {}) });
check("routines.create answers with the saved routine", created.ok && !!created.body.routine?.id, created.ok ? "" : created.text);
const taskId = created.body.routine?.id;
if (taskId) {
  const one = await call<{ routine: Routine }>("routines.list", { taskId });
  check("routines.list { taskId } shows its full settings", one.body.routine?.agent?.prompt === base.prompt && one.body.routine.agent.onSchedule === false);

  const page = await call<{ runs: Run[]; nextCursor: string | null }>("routines.runs", { taskId });
  check("routines.runs returns a page with nextCursor", page.ok && Array.isArray(page.body.runs) && "nextCursor" in page.body);

  const updated = await call<{ routine: Routine }>("routines.update", { taskId, patch: { title: "Proof: MCP routine (edited)", events: [] } });
  check("routines.update answers with the change saved", updated.body.routine?.title === "Proof: MCP routine (edited)" && !(updated.body.routine.agent.events?.length), updated.ok ? "" : updated.text);

  if (!skipRun) {
    const started = await call<{ sessionId: string }>("routines.run", { taskId });
    check("routines.run answers with a session id", started.ok && !!started.body.sessionId, started.ok ? "" : started.text);
    let run: Run | undefined;
    for (let attempt = 0; attempt < 72 && started.body.sessionId; attempt++) {
      run = (await call<{ run: Run }>("routines.runs", { taskId, sessionId: started.body.sessionId })).body.run;
      if (run && run.status !== "running") break;
      await Bun.sleep(5_000);
    }
    check("the run finishes, started by Run now", run?.status === "completed" && run.startedBy.type === "manual", `${run?.status}: ${run?.result ?? run?.skipReason ?? ""}`);
    const transcript = await call<{ transcript: { lines: string[] } }>("routines.runs", { taskId, sessionId: started.body.sessionId, transcript: true });
    check("routines.runs { transcript: true } returns the steps", (transcript.body.transcript?.lines.length ?? 0) > 0, transcript.body.transcript?.lines.slice(-1)[0]?.slice(0, 120));
  }

  const deleted = await call("routines.delete", { taskId });
  check("routines.delete removes it", deleted.ok);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);

/**
 * Try the people flow with staging data. Staging only: it refuses to run against the production project.
 *
 *   bun --env-file=.env.staging run backend/src/people/staging-demo.ts <command> --workspace <slug> [options]
 *
 *   status                          people, identities, admins, Slack, and the demo routine
 *   seed --owner <email>            sync people, save the "Meeting follow-up" routine for that user
 *        [--sync]                   also read Slack and Linear directories now
 *        [--slack email=U123 ...]   confirm a Slack member id for a person (staging shortcut for a real Slack sync)
 *   meeting [--as "Name: task" ...] store a shared demo meeting that gives people action items
 *   fire --source <id> [--wait]     start the routine for that meeting, as the Fireflies webhook would
 *   cleanup                         remove the demo meetings, the demo routine and the confirmed ids this tool added
 */
import { createHash } from "node:crypto";
import { serviceClient } from "../db/client";
import { upsertSourceConnection, upsertSourceItem } from "../ingestion/upsert-source-item";
import { startEventRoutines } from "../routines/start-event-routines";
import { loadSandboxDeploymentConfig } from "../sandbox";
import { addIdentity } from "./match";
import { meetingFollowUpRoutine } from "./demo-routine";
import { assertNotProduction, readProductionEnvText } from "./production-guard";
import { syncMembers } from "./sync-members";
import { syncPeople } from "./sync";

const DEMO_TASK_KEY = "people-demo-meeting-follow-up";
const DEMO_CONNECTION_KEY = "people-demo";
const db = serviceClient;

interface Args {
  command: string;
  workspace?: string;
  owner?: string;
  source?: string;
  sync: boolean;
  wait: boolean;
  slack: string[];
  as: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? "", sync: false, wait: false, slack: [], as: [] };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--sync") args.sync = true;
    else if (flag === "--wait") args.wait = true;
    else if (flag === "--workspace") args.workspace = argv[++i];
    else if (flag === "--owner") args.owner = argv[++i];
    else if (flag === "--source") args.source = argv[++i];
    else if (flag === "--slack") args.slack.push(argv[++i] ?? "");
    else if (flag === "--as") args.as.push(argv[++i] ?? "");
    else throw new Error(`Unknown option: ${flag}`);
  }
  return args;
}

async function workspaceBySlug(slug: string | undefined) {
  if (!slug) throw new Error("Pass --workspace <slug>");
  const { data, error } = await db.from("workspaces").select("id, slug, team_id").eq("slug", slug).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No workspace with slug "${slug}"`);
  return data as { id: string; slug: string; team_id: string };
}

const log = (line = "") => console.log(line);

async function status(workspaceId: string) {
  await syncMembers(db, workspaceId);
  const { data: people } = await db.from("people").select("id, display_name, status, affiliation, user_id, created_by").eq("workspace_id", workspaceId).order("display_name");
  const { data: identities } = await db.from("person_identities").select("person_id, provider, status, evidence").eq("workspace_id", workspaceId);
  const { data: admins } = await db.from("users").select("email").eq("primary_team_id", (await db.from("workspaces").select("team_id").eq("id", workspaceId).single()).data!.team_id).in("organization_role", ["owner", "admin"]).eq("status", "active");
  const { data: slack } = await db.from("source_connections").select("status").eq("workspace_id", workspaceId).eq("provider", "slack").maybeSingle();
  const { data: tasks } = await db.from("scheduled_tasks").select("id, enabled, config_json, created_by_user_id").eq("workspace_id", workspaceId).eq("task_type", "agent_routine").is("deleted_at", null);

  log(`Slack: ${slack ? (slack as { status: string }).status : "not connected"}`);
  log(`Admins: ${(admins ?? []).map((a: { email: string }) => a.email).join(", ") || "none"}`);
  log("");
  log("People:");
  for (const person of (people ?? []) as Array<{ id: string; display_name: string; status: string; user_id: string | null; created_by: string }>) {
    const own = ((identities ?? []) as Array<{ person_id: string; provider: string; status: string }>).filter((identity) => identity.person_id === person.id);
    log(`  ${person.display_name.padEnd(24)} ${person.status.padEnd(9)} ${person.user_id ? "account" : "no account"}  [${own.map((identity) => `${identity.provider}:${identity.status}`).join(", ") || "no identities"}]  ${person.id}`);
  }
  log("");
  log("Routines that listen for events:");
  const listening = ((tasks ?? []) as Array<{ id: string; enabled: boolean; config_json: { title?: string; events?: string[]; canNotify?: boolean } }>).filter((task) => task.config_json.events?.length);
  if (!listening.length) log("  none. Run: seed --owner <email>");
  for (const task of listening) log(`  ${task.config_json.title} (${task.enabled ? "on" : "off"}, can message: ${task.config_json.canNotify ? "yes" : "no"}) ${task.id}`);
}

async function seed(workspaceId: string, args: Args) {
  if (!args.owner) throw new Error("Pass --owner <email>: the person the routine runs for");
  await syncMembers(db, workspaceId);
  if (args.sync) await syncPeople(db, workspaceId);

  for (const pair of args.slack) {
    const [email, slackId] = pair.split("=");
    if (!email || !slackId) throw new Error(`--slack needs email=U123, got "${pair}"`);
    const { data: identity } = await db.from("person_identities").select("person_id").eq("workspace_id", workspaceId).eq("provider", "email").eq("external_id", email.toLowerCase()).maybeSingle();
    if (!identity) throw new Error(`No person with the email ${email}. Run status to see who is known.`);
    const outcome = await addIdentity(db, workspaceId, (identity as { person_id: string }).person_id, {
      provider: "slack", externalId: slackId, handle: email, status: "confirmed", evidence: { demo: true },
    });
    log(`Slack id for ${email}: ${outcome}`);
  }

  const { data: owner } = await db.from("users").select("id").eq("email", args.owner.toLowerCase()).maybeSingle();
  if (!owner) throw new Error(`No user with the email ${args.owner}`);
  const config = meetingFollowUpRoutine();
  const { data: existing } = await db.from("scheduled_tasks").select("id").eq("workspace_id", workspaceId).eq("task_type", "agent_routine").eq("task_key", DEMO_TASK_KEY).maybeSingle();
  if (existing) {
    const { error } = await db.from("scheduled_tasks").update({ config_json: config, created_by_user_id: (owner as { id: string }).id, enabled: true, deleted_at: null }).eq("id", (existing as { id: string }).id);
    if (error) throw error;
    log(`Updated the demo routine ${(existing as { id: string }).id}`);
  } else {
    const { data, error } = await db.from("scheduled_tasks").insert({
      workspace_id: workspaceId, task_type: "agent_routine", task_key: DEMO_TASK_KEY, schedule_kind: "cron", cron_expression: "0 0 1 1 *",
      timezone: "UTC", enabled: true, config_json: config,
      // No next due time: the schedule never fires, so the routine runs only when a meeting is summarized.
      next_due_at: null, created_by_user_id: (owner as { id: string }).id, updated_by_user_id: (owner as { id: string }).id,
    }).select("id").single();
    if (error) throw error;
    log(`Saved the demo routine ${(data as { id: string }).id}, on behalf of ${args.owner}`);
  }
  log("It can message teammates and starts when a Fireflies meeting is summarized.");
}

async function meeting(workspaceId: string, args: Args) {
  const { data: people } = await db.from("people").select("id, display_name").eq("workspace_id", workspaceId).eq("status", "active").eq("affiliation", "member").order("display_name");
  const everyone = (people ?? []) as Array<{ id: string; display_name: string }>;
  const names = everyone.slice(0, 3).map((person) => person.display_name);
  const items = args.as.length
    ? args.as.map((entry) => entry.split(/:(.*)/s, 2) as [string, string])
    : names.map((name, index) => [name, ["send the pricing draft by Friday", "book the customer interviews", "review the launch email tomorrow"][index] ?? "follow up"] as [string, string]);
  if (!items.length) throw new Error("No active people to give action items to. Run seed first.");

  // Like a real Fireflies meeting, the attendees' emails go in the metadata: that is how a search by person finds it.
  const { data: emailRows } = await db.from("person_identities").select("person_id, external_id").eq("workspace_id", workspaceId).eq("provider", "email");
  const emailOf = (name: string) => {
    const person = everyone.find((candidate) => candidate.display_name.toLowerCase() === name.trim().toLowerCase());
    return ((emailRows ?? []) as Array<{ person_id: string; external_id: string }>).find((row) => row.person_id === person?.id)?.external_id;
  };
  const attendeeEmails = items.map(([name]) => emailOf(name)).filter((email): email is string => !!email);

  const stamp = new Date().toISOString();
  const content = `# Demo standup\n\n**Date:** ${stamp}\n**Attendees:** ${items.map(([name]) => name).join(", ")}\n\n## Action Items\n\n${items.map(([name, task]) => `- **${name.trim()}**: ${task.trim()}`).join("\n")}\n`;
  const connection = await upsertSourceConnection(db, { workspace_id: workspaceId, provider: "manual_upload", connection_key: DEMO_CONNECTION_KEY, display_name: "People demo", status: "active" });
  const hash = createHash("sha256").update(content).digest("hex");
  const { item } = await upsertSourceItem(db, {
    workspace_id: workspaceId, source_connection_id: connection.id, item_type: "meeting_transcript", external_id: `demo-${Date.now()}`, external_version: hash,
    occurred_at: stamp, content_markdown: content, content_hash: hash, representation_kind: "summary", time_basis: "source_event",
    metadata_json: { title: "Demo standup", demo: true, attendees: items.map(([name]) => name), attendee_emails: attendeeEmails }, visibility: "shared", owner_user_id: null,
  });
  log(`Stored the demo meeting ${item.id}`);
  log(content);
  log(`Next: fire --source ${item.id} --wait`);
}

async function fire(workspaceId: string, args: Args) {
  if (!args.source) throw new Error("Pass --source <source item id> from the meeting command");
  const startedAt = new Date().toISOString();
  const started = await startEventRoutines(db, loadSandboxDeploymentConfig(), { workspaceId, name: "fireflies.meeting_summarized", eventId: `demo-${args.source}`, sourceItemId: args.source });
  log(`Started ${started} routine run(s).`);
  if (!started || !args.wait) return;

  log("Waiting for the run to finish (up to 6 minutes)...");
  for (let waited = 0; waited < 360; waited += 10) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 10_000));
    const { data: runs } = await db.from("agent_runs").select("id, status, failure_code, summary").eq("workspace_id", workspaceId).eq("kind", "routine").gte("created_at", startedAt).order("created_at", { ascending: false }).limit(1);
    const run = (runs ?? [])[0] as { id: string; status: string; failure_code: string | null; summary: string | null } | undefined;
    if (!run || ["queued", "preparing", "running", "validating", "committing"].includes(run.status)) continue;
    log(`Run ${run.id}: ${run.status}${run.failure_code ? ` (${run.failure_code})` : ""}`);
    const { data: calls } = await db.from("agent_run_tool_calls").select("tool_name, status, result_summary").eq("agent_run_id", run.id).like("tool_name", "people.%").order("created_at");
    for (const call of (calls ?? []) as Array<{ tool_name: string; status: string; result_summary: string | null }>) log(`  ${call.tool_name} ${call.status} ${call.result_summary ?? ""}`);
    if (run.summary) log(`\n${run.summary}`);
    return;
  }
  log("Still running. Check the run in the app, or run status again later.");
}

async function cleanup(workspaceId: string) {
  const { data: tasks } = await db.from("scheduled_tasks").select("id").eq("workspace_id", workspaceId).eq("task_key", DEMO_TASK_KEY);
  for (const task of (tasks ?? []) as Array<{ id: string }>) {
    const { error } = await db.from("scheduled_tasks").update({ enabled: false, deleted_at: new Date().toISOString() }).eq("id", task.id);
    if (error) throw error;
  }
  const { data: connection } = await db.from("source_connections").select("id").eq("workspace_id", workspaceId).eq("provider", "manual_upload").eq("connection_key", DEMO_CONNECTION_KEY).maybeSingle();
  if (connection) {
    const { error } = await db.from("source_items").delete().eq("workspace_id", workspaceId).eq("source_connection_id", (connection as { id: string }).id);
    if (error) throw error;
  }
  const { error: identityError } = await db.from("person_identities").delete().eq("workspace_id", workspaceId).eq("evidence->>demo", "true");
  if (identityError) throw identityError;
  log("Removed the demo routine, the demo meetings and the Slack ids this tool confirmed.");
}

assertNotProduction(process.env.SUPABASE_URL, readProductionEnvText(import.meta.dir), { what: "The people demo only runs on staging." });
const args = parseArgs(process.argv.slice(2));
const workspace = await workspaceBySlug(args.workspace);
log(`Workspace: ${workspace.slug} (staging)\n`);
switch (args.command) {
  case "status": await status(workspace.id); break;
  case "seed": await seed(workspace.id, args); break;
  case "meeting": await meeting(workspace.id, args); break;
  case "fire": await fire(workspace.id, args); break;
  case "cleanup": await cleanup(workspace.id); break;
  default: throw new Error("Commands: status, seed, meeting, fire, cleanup. See the top of this file.");
}

import { createClient } from "@supabase/supabase-js";
import { strict as assert } from "node:assert";
import { POST } from "../../routes/errors";
import { REOPEN, HEARTBEAT, END } from "../../routes/sessions-live";
import { sessionFailureMessage } from "draft-core/session-failure";
const staging = await Bun.file(new URL("../../../../.env.staging", import.meta.url)).text();
const expected = staging.match(/^SUPABASE_URL=["']?([^"'\r\n]+)/m)?.[1];
assert(expected && expected === process.env.SUPABASE_URL, "Use --env-file=.env.staging");
const db = createClient(expected, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const auth = createClient(expected, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const suffix = crypto.randomUUID(), password = crypto.randomUUID() + "aA1!", hostId = `verify-${suffix}`;
let org: string | undefined, user: string | undefined, workspace: string | undefined;
function checked<R extends { data: unknown; error: { message: string } | null }>(r: R): NonNullable<R["data"]> { if (r.error) throw Error(r.error.message); return r.data as NonNullable<R["data"]>; }
try {
  org = checked(await db.from("organizations").insert({ slug: `verify-${suffix}`, name: "Resume verification" }).select("id").single()).id;
  const team = checked(await db.from("teams").insert({ organization_id: org, slug: `verify-${suffix}`, name: "Resume verification" }).select("id").single());
  workspace = checked(await db.from("workspaces").insert({ organization_id: org, team_id: team.id, slug: `verify-${suffix}`, name: "Resume verification" }).select("id").single()).id;
  user = checked(await db.auth.admin.createUser({ email: `verify-${suffix}@example.test`, password, email_confirm: true })).user!.id;
  checked(await db.from("users").update({ organization_id: org, primary_team_id: team.id, organization_role: "admin", status: "active" }).eq("id", user));
  const token = checked(await auth.auth.signInWithPassword({ email: `verify-${suffix}@example.test`, password })).session!.access_token;
  const sessionId = checked(await db.from("sessions").insert({ workspace_id: workspace, owner_user_id: user, host_id: hostId, harness: "codex", status: "ended", end_reason: "exited", runtime: "local" }).select("id").single()).id;
  const request = (input: any, bearer = token) => {
    const body = input.failure ? {
      id: input.failure.id, code: input.failure.code, message: input.failure.message ?? "Session failure",
      operation: "session", sessionId, hostId: input.hostId, padding: input.padding,
      detail: { phase: input.phase, ...input.diagnostics },
      sessionFailure: { requestId: input.failure.requestId, at: input.failure.at, terminal: input.terminal, expectedRequestId: input.expectedRequestId },
    } : input;
    return Object.assign(new Request("http://localhost/test", { method: "POST", headers: { authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) }), { params: { id: workspace!, sessionId } }) as never;
  };
  const current = async () => checked(await db.from("sessions").select("status,last_failure,resume_request_id,last_seq").eq("id", sessionId).single());
  const attempt = crypto.randomUUID();
  assert.equal((await REOPEN(request({ hostId, requestId: attempt }))).status, 200);
  assert.equal((await REOPEN(request({ hostId, requestId: crypto.randomUUID() }))).status, 409);
  const failure = { id: crypto.randomUUID(), requestId: attempt, code: "host_recovery_exhausted", at: new Date().toISOString(), message: "Bearer must-not-be-stored" };
  const body = { hostId, failure, expectedRequestId: null, terminal: true, phase: "reconnect", diagnostics: { reason: "connection_closed", exitCode: 1, transcript: "must-not-be-stored" } };
  assert.equal((await POST(request({ ...body, terminal: false, failure: { ...failure, id: crypto.randomUUID(), code: "host_connection_lost" } }))).status, 200);
  assert.equal((await current()).status, "live");
  assert.equal((await current()).last_seq, 0);
  assert.equal((await POST(request(body))).status, 200);
  assert.equal((await current()).status, "ended");
  assert.equal((await current()).last_failure.message, sessionFailureMessage("host_recovery_exhausted", "codex"));
  assert.equal((await POST(request(body))).status, 200);
  const errors = checked(await db.from("errors").select("id,detail_json").eq("session_id", sessionId));
  assert.equal(errors.length, 2);
  assert.equal(errors.find(row => row.id === failure.id)!.detail_json.exitCode, 1);
  assert(!JSON.stringify(errors).includes("must-not-be-stored"));
  const notes = checked(await db.from("session_events").select("seq,payload").eq("session_id", sessionId));
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.payload.failure.id, failure.id);
  const next = crypto.randomUUID();
  assert.equal((await REOPEN(request({ hostId, requestId: next }))).status, 200);
  assert.equal((await HEARTBEAT(request({ hostId, readyRequestId: next }))).status, 200);
  assert.equal((await current()).last_failure, null);
  assert.equal((await POST(request({ ...body, failure: { ...failure, id: crypto.randomUUID() } }))).status, 200);
  assert.equal((await current()).status, "live");
  assert.equal((await current()).last_failure, null);
  assert.equal((await current()).resume_request_id, next);
  assert.equal((await END(request({ hostId, requestId: attempt, reason: "exited" }))).status, 409);
  assert.equal((await current()).status, "live");
  assert.equal((await POST(request({ ...body, hostId: "foreign-host" }))).status, 403);
  assert.equal((await POST(request({ ...body, failure: { ...failure, code: "unknown" } }))).status, 400);
  assert.equal((await POST(request(body, "invalid"))).status, 401);
  assert.equal((await POST(request({ ...body, padding: "x".repeat(9000) }))).status, 413);
  assert.equal((await current()).last_seq, 2);
  const generalId = crypto.randomUUID();
  const general = { id: generalId, operation: "read", code: "view_fetch_failed", message: "View load failed token=private", detail: { token: "private", status: 500 } };
  assert.equal((await POST(request(general))).status, 200);
  assert.equal((await POST(request(general))).status, 200);
  const generalRows = checked(await db.from("errors").select("id,message,detail_json").eq("id", generalId));
  assert.equal(generalRows.length, 1);
  assert(!JSON.stringify(generalRows).includes("private"));
  assert.equal((await current()).status, "live");
  assert.equal((await current()).last_seq, 2);
  console.log("PASS staging: authenticated reporting, durable error/history, deduplication, safe metadata, stale attempts, readiness and invalid/foreign request rejection");
} finally {
  if (workspace) checked(await db.from("errors").delete().eq("workspace_id", workspace));
  if (user) checked(await db.auth.admin.deleteUser(user));
  if (org) checked(await db.from("organizations").delete().eq("id", org));
  console.log("Staging verification fixtures removed");
}

import { withHostAuth } from "../auth/with-host-auth";
import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import { recordError } from "../errors/record-error";
import { productionStartDeps } from "../cloud-sessions/deps";
import { parseCloudStart } from "../cloud-sessions/parse-start";
import { startCloudSession } from "../cloud-sessions/start";
import { SLEEPABLE_STATUSES, sleepCloudSession } from "../cloud-sessions/sleep";
import { discardSnapshot, snapshotKeyOf, storageSnapshotStore } from "../cloud-sessions/snapshot-seed";
import { wakeCloudSession } from "../cloud-sessions/wake";
import { CLAUDE_LAUNCH_ONLY_MODES, DEFAULT_HARNESS_ID, harnessModeValues, isEffortFor, isHarnessId, isKnownModel } from "draft-core/harnesses";
import { EVENTS_PAGE_SIZE, splitAuthor } from "draft-core/live-sessions";
import { isIncomingLine, type IncomingLine } from "draft-core/harnesses/claude/live-lines";
import { eventsForHarness } from "../ingestion/harness-lines";
import { latestNativeTitle } from "draft-core/harnesses/claude/native-title";
import type { SessionEventRow, SessionRow } from "../types/tables";
import { loadDisplayNames } from "./session-display-names";
import { failQueuedInputs, loadViewerInputs, matchConsumedInputs } from "./sessions-live-inputs";
import { SESSION_COLUMNS, authorize, authorizeHostMember, authorizeHostSession, authorizeOwned, errorResponse, hostIdFor, knownDbError, loadOwnedSession, optionalString, readBody } from "./sessions-live-shared";

type WorkspaceRequest = Bun.BunRequest<"/workspaces/:id/live-sessions">;
type SessionRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId">;
type EventsRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/events">;
type LinesRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/lines">;
type HeartbeatRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/heartbeat">;
type EndRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/end">;
type DeleteRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId">;
type ReopenRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/reopen">;
type RawRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/raw">;
type RawCompleteRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/raw/complete">;
type HostSleepRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/host/sleep">;

const MAX_LINES_PER_POST = 2000;
const MAX_EVENTS_PAGE = 1000;
const LIST_LIMIT = 50;
const TITLE_MAX_CHARS = 120;
const RAW_BUCKET = "session-raw";
const RAW_FILE = /^(root|subagents\/agent-[A-Za-z0-9_-]+)\.jsonl$/;

/** The sessions with their owners' names, and the caller's own name, from one lookup. */
async function withOwnerNames(workspaceId: string, sessions: SessionRow[], callerId: string) {
  const names = await loadDisplayNames(serviceClient, [...new Set([callerId, ...sessions.map((s) => s.owner_user_id)])], []);
  if (!names.ok) return errorResponse(names.code, 500, names.detail, workspaceId);
  return {
    sessions: sessions.map((s) => ({ ...s, owner_name: names.users.get(s.owner_user_id) ?? null, mine: s.owner_user_id === callerId })),
    viewer: { id: callerId, name: names.users.get(callerId) ?? "A teammate" },
  };
}

export const LIST = withAuth<WorkspaceRequest>(async (req, caller) => {
  const denied = await authorize(req.params.id, caller.userId);
  if (denied) return denied;

  const { data, error } = await serviceClient
    .from("sessions")
    .select(SESSION_COLUMNS)
    .eq("workspace_id", req.params.id)
    .eq("session_type", "interactive")
    .is("deleted_at", null)
    .order("started_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) return errorResponse("sessions_lookup_failed", 500, error, req.params.id);

  const named = await withOwnerNames(req.params.id, (data ?? []) as SessionRow[], caller.userId);
  if (named instanceof Response) return named;
  return Response.json({ sessions: named.sessions });
});

/** A cloud session starts its first run in a sandbox now. A failure ends the session, and the response says why. */
async function createCloudSession(workspaceId: string, ownerUserId: string, body: Record<string, unknown>): Promise<Response> {
  const parsed = parseCloudStart(body, { workspaceId, ownerUserId });
  if (!parsed.ok) return Response.json({ ok: false, error: parsed.error }, { status: 400 });

  let deps: ReturnType<typeof productionStartDeps>;
  try {
    deps = productionStartDeps();
  } catch (error) {
    await recordError({ workspaceId, operation: "session", code: "sandbox_config_invalid", message: "The sandbox settings for cloud sessions are missing or invalid", error });
    return Response.json({ ok: false, error: "sandbox_not_configured" }, { status: 500 });
  }

  const started = await startCloudSession(parsed.input, deps);
  if (!started.ok) return Response.json({ ok: false, error: started.error }, { status: started.status });

  const { data, error } = await serviceClient.from("sessions").select(SESSION_COLUMNS).eq("id", started.sessionId).maybeSingle<SessionRow>();
  if (error || !data) return errorResponse("session_lookup_failed", 500, error, workspaceId, started.sessionId);
  return Response.json({ ok: true, session: data }, { status: 201 });
}

export const CREATE = withAuth<WorkspaceRequest>(async (req, caller) => {
  const denied = await authorize(req.params.id, caller.userId);
  if (denied) return denied;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;

  if (body.runtime !== undefined && body.runtime !== "local") {
    if (body.runtime === "cloud") return createCloudSession(req.params.id, caller.userId, body);
    return errorResponse("unknown_runtime", 400);
  }

  const hostId = optionalString(body.hostId, 200);
  if (!hostId) return errorResponse("missing_host_id", 400);

  const harness = body.harness ?? DEFAULT_HARNESS_ID;
  if (!isHarnessId(harness)) return errorResponse("unknown_harness", 400);
  const model = optionalString(body.model, 100);
  if (!isKnownModel(harness, model)) return errorResponse("unknown_model", 400);
  const reasoningEffort = optionalString(body.reasoningEffort, 20);
  if (!isEffortFor(harness, model, reasoningEffort)) return errorResponse("unknown_reasoning_effort", 400);

  const previousSessionId = optionalString(body.previousSessionId, 100);
  if (previousSessionId) {
    const previous = await loadOwnedSession(req.params.id, previousSessionId, caller.userId);
    if (!previous.ok) return previous.response;
    if (previous.session.host_id !== hostId) return errorResponse("foreign_host", 403);
  }

  const { data, error } = await serviceClient
    .from("sessions")
    .insert({
      workspace_id: req.params.id,
      owner_user_id: caller.userId,
      host_id: hostId,
      harness,
      harness_version: optionalString(body.harnessVersion, 100),
      previous_session_id: previousSessionId,
      host_name: optionalString(body.hostName, 200),
      folder_name: optionalString(body.folderName, 200),
      git_remote: optionalString(body.gitRemote, 500),
      model,
      reasoning_effort: reasoningEffort,
      native_session_id: optionalString(body.nativeSessionId, 200),
    })
    .select(SESSION_COLUMNS)
    .single<SessionRow>();
  if (error || !data) return errorResponse("session_create_failed", 500, error, req.params.id);

  return Response.json({ ok: true, session: data }, { status: 201 });
});

const LINK_COLUMNS = "id, title, folder_name";
type SessionLink = Pick<SessionRow, "id" | "title" | "folder_name">;

/** The session this one continues, and the one that continues it after a /clear. */
export async function loadSessionLinks(workspaceId: string, session: SessionRow) {
  const previous = session.previous_session_id
    ? serviceClient.from("sessions").select(LINK_COLUMNS).eq("id", session.previous_session_id).eq("workspace_id", workspaceId).is("deleted_at", null).maybeSingle<SessionLink>()
    : null;
  const next =
    session.status === "ended" && session.end_reason === "cleared"
      ? serviceClient.from("sessions").select(LINK_COLUMNS).eq("previous_session_id", session.id).eq("workspace_id", workspaceId).is("deleted_at", null).order("started_at", { ascending: false }).limit(1).maybeSingle<SessionLink>()
      : null;
  const [previousResult, nextResult] = await Promise.all([previous, next]);
  const failed = previousResult?.error ?? nextResult?.error;
  if (failed) return errorResponse("session_lookup_failed", 500, failed, workspaceId, session.id);
  return { previous_session: previousResult?.data ?? null, next_session: nextResult?.data ?? null };
}

export const EVENTS = withAuth<EventsRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const params = new URL(req.url).searchParams;
  const after = Math.max(0, Number(params.get("after")) || 0);
  const limit = Math.min(MAX_EVENTS_PAGE, Math.max(1, Number(params.get("limit")) || EVENTS_PAGE_SIZE));

  const [denied, { data: session, error: sessionError }, { data: events, error: eventsError }, viewerInputs] = await Promise.all([
    authorize(workspaceId, caller.userId),
    serviceClient.from("sessions").select(SESSION_COLUMNS).eq("id", sessionId).eq("workspace_id", workspaceId).is("deleted_at", null).maybeSingle<SessionRow>(),
    serviceClient
      .from("session_events")
      .select("seq, source_id, kind, payload, created_at")
      .eq("session_id", sessionId)
      .eq("workspace_id", workspaceId)
      .gt("seq", after)
      .order("seq", { ascending: true })
      .limit(limit),
    loadViewerInputs(workspaceId, sessionId, caller.userId),
  ]);
  if (denied) return denied;
  if (sessionError) return errorResponse("session_lookup_failed", 500, sessionError, workspaceId, sessionId);
  if (!session) return errorResponse("session_not_found", 404);
  if (eventsError) return errorResponse("events_lookup_failed", 500, eventsError, workspaceId, sessionId);
  if (!viewerInputs.ok) return errorResponse("inputs_lookup_failed", 500, viewerInputs.error, workspaceId, sessionId);

  const rows = (events ?? []) as Partial<SessionEventRow>[];
  const [links, authors, recent] = await Promise.all([
    loadSessionLinks(workspaceId, session),
    loadTurnAuthors(workspaceId, sessionId, rows),
    loadRecentAuthors(workspaceId, sessionId),
  ]);
  if (links instanceof Response) return links;
  if (!authors.ok) return errorResponse("inputs_lookup_failed", 500, authors.error, workspaceId, sessionId);
  if (!recent.ok) return errorResponse("inputs_lookup_failed", 500, recent.error, workspaceId, sessionId);

  const authorIds = [
    ...new Set([
      caller.userId,
      session.owner_user_id,
      ...authors.bySeq.values(),
      ...recent.rows.map((r) => r.author_user_id),
      ...viewerInputs.inputs.map((i) => i.author_user_id),
    ]),
  ];
  const names = await loadDisplayNames(serviceClient, authorIds, []);
  if (!names.ok) return errorResponse(names.code, 500, names.detail, workspaceId, sessionId);
  const withAuthors = rows.map((e) => {
    if (e.kind !== "user_message") return e;
    const authorId = authors.bySeq.get(e.seq as number) ?? null;
    return { ...e, author_user_id: authorId, author_name: authorId ? (names.users.get(authorId) ?? null) : null };
  });
  // The name saved with a waiting message is from send time. The current one wins.
  const inputs = viewerInputs.inputs.map((i) => ({ ...i, author_name: names.users.get(i.author_user_id) ?? i.author_name }));
  const authorList = recent.rows.map((r) => ({ seq: r.consumed_seq, author_user_id: r.author_user_id, author_name: names.users.get(r.author_user_id) ?? null }));
  return Response.json({
    session: { ...session, owner_name: names.users.get(session.owner_user_id) ?? null, mine: session.owner_user_id === caller.userId, ...links },
    viewer: { id: caller.userId, name: names.users.get(caller.userId) ?? "A teammate" },
    events: withAuthors,
    inputs,
    authors: authorList,
  });
});

const RECENT_AUTHORS_LIMIT = 20;

/** Who sent the latest messages Claude took, newest first, for labelling a session's recent turns. */
export async function loadRecentAuthors(workspaceId: string, sessionId: string) {
  const { data, error } = await serviceClient
    .from("session_inputs")
    .select("consumed_seq, author_user_id")
    .eq("session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .eq("kind", "message")
    .not("consumed_seq", "is", null)
    .order("consumed_seq", { ascending: false })
    .limit(RECENT_AUTHORS_LIMIT);
  if (error) return { ok: false as const, error };
  return { ok: true as const, rows: (data ?? []) as { consumed_seq: number; author_user_id: string }[] };
}

/** Who sent each user turn that came through Draft, by event seq. A turn typed in the terminal has no entry. */
export async function loadTurnAuthors(workspaceId: string, sessionId: string, events: { seq?: number; kind?: string }[]) {
  const seqs = events.filter((e) => e.kind === "user_message").map((e) => e.seq as number);
  const bySeq = new Map<number, string>();
  if (seqs.length === 0) return { ok: true as const, bySeq };
  const { data, error } = await serviceClient
    .from("session_inputs")
    .select("consumed_seq, author_user_id")
    .eq("session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .eq("kind", "message")
    .in("consumed_seq", seqs);
  if (error) return { ok: false as const, error };
  for (const row of (data ?? []) as { consumed_seq: number; author_user_id: string }[]) bySeq.set(row.consumed_seq, row.author_user_id);
  return { ok: true as const, bySeq };
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim().slice(0, TITLE_MAX_CHARS) ?? "";
}

export const LINES = withHostAuth<LinesRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const owned = await authorizeHostSession(workspaceId, sessionId, caller);
  if (!owned.ok) return owned.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const { body } = parsed;

  const target = hostIdFor(caller, optionalString(body.hostId, 200));
  if (!target.ok) return target.response;
  const hostId = target.hostId;
  if (!hostId) return errorResponse("missing_host_id", 400);
  if (!Array.isArray(body.lines) || body.lines.length > MAX_LINES_PER_POST || !body.lines.every(isIncomingLine)) {
    return errorResponse("invalid_lines", 400);
  }

  const incoming = body.lines as IncomingLine[];
  for (const line of incoming) {
    if ("oversizeBytes" in line) {
      // Stored error rows keep the `file` and `offset` keys they were written with.
      void recordError({
        workspaceId,
        sessionId,
        operation: "session",
        message: "Session line too large to forward",
        code: "line_too_large",
        detail: { file: line.stream, offset: line.position, bytes: line.oversizeBytes },
      });
    }
  }
  const events = incoming
    .flatMap((line) => eventsForHarness(owned.session.harness, line))
    .map((event) => ({ source_id: event.sourceId, kind: event.kind, payload: event.payload }));

  const firstPrompt = events.find((e) => e.kind === "user_message" && !(e.payload as { agent_id?: string }).agent_id);
  let lastSeq = owned.session.last_seq;
  let inserted = 0;
  if (events.length > 0) {
    const { data, error } = await serviceClient.rpc("append_session_events", {
      p_session_id: sessionId,
      p_workspace_id: workspaceId,
      p_host_id: hostId,
      p_events: events,
    });
    if (error) {
      return knownDbError(error.message) ?? errorResponse("append_failed", 500, error, workspaceId, sessionId);
    }
    ({ last_seq: lastSeq, inserted } = data as { last_seq: number; inserted: number });
    if (inserted > 0 && firstPrompt) await matchConsumedInputs(workspaceId, sessionId, owned.session.last_seq, lastSeq);
  } else if (owned.session.host_id !== hostId) {
    return errorResponse("foreign_host", 403);
  }

  const nativeSessionId = optionalString(body.nativeSessionId, 200);
  const nativeTitle = latestNativeTitle(incoming, TITLE_MAX_CHARS);
  if (nativeTitle) {
    if (nativeTitle !== owned.session.title) await serviceClient.from("sessions").update({ title: nativeTitle }).eq("id", sessionId);
  } else if (owned.session.title === null && firstPrompt) {
    const title = firstLine(splitAuthor((firstPrompt.payload as { text: string }).text).text);
    if (title) await serviceClient.from("sessions").update({ title }).eq("id", sessionId).is("title", null);
  }
  if (owned.session.native_session_id === null && nativeSessionId) {
    await serviceClient.from("sessions").update({ native_session_id: nativeSessionId }).eq("id", sessionId).is("native_session_id", null);
  }

  return Response.json({ ok: true, last_seq: lastSeq, inserted });
});

const REPORTED_PERMISSION_MODES = [...harnessModeValues("claude", "permission"), ...CLAUDE_LAUNCH_ONLY_MODES];
const APPROVAL_MODES = harnessModeValues("codex", "approval");

/** A mode the host reports, or null for anything unknown, which leaves the saved mode as it is. */
const reportedMode = (value: unknown, allowed: string[]): string | null => (typeof value === "string" && allowed.includes(value) ? value : null);

/** Saves the model and effort a host reports. Returns an error response, or null when nothing was wrong or sent. */
async function reportedAgent(sessionId: string, workspaceId: string, hostId: string, body: Record<string, unknown>): Promise<Response | null> {
  if (!("model" in body) && !("reasoningEffort" in body)) return null;
  const { data: session } = await serviceClient.from("sessions").select("harness, model, reasoning_effort").eq("id", sessionId).eq("workspace_id", workspaceId).eq("host_id", hostId).maybeSingle<{ harness: string; model: string | null; reasoning_effort: string | null }>();
  if (!session) return null;
  const model = "model" in body ? optionalString(body.model, 100) : session.model;
  const effort = "reasoningEffort" in body ? optionalString(body.reasoningEffort, 20) : session.reasoning_effort;
  if (!isKnownModel(session.harness, model) || !isEffortFor(session.harness, model, effort)) return null;
  if (model === session.model && effort === session.reasoning_effort) return null;
  const { error } = await serviceClient.from("sessions").update({ model, reasoning_effort: effort }).eq("id", sessionId).eq("workspace_id", workspaceId).eq("host_id", hostId);
  return error ? errorResponse("heartbeat_failed", 500, error, workspaceId, sessionId) : null;
}

/** The host says it is alive. A session marked host_offline returns to live. */
export const HEARTBEAT = withHostAuth<HeartbeatRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const member = await authorizeHostMember(workspaceId, caller);
  if (!member.ok) return member.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const target = hostIdFor(caller, optionalString(parsed.body.hostId, 200));
  if (!target.ok) return target.response;
  const hostId = target.hostId;
  if (!hostId) return errorResponse("missing_host_id", 400);

  const { data, error } = await serviceClient.rpc("heartbeat_session", {
    p_session_id: sessionId,
    p_workspace_id: workspaceId,
    p_host_id: hostId,
    p_harness_version: optionalString(parsed.body.harnessVersion, 100),
    p_permission_mode: reportedMode(parsed.body.permissionMode, REPORTED_PERMISSION_MODES),
    p_approval_mode: reportedMode(parsed.body.approvalMode, APPROVAL_MODES),
  });
  if (error) return knownDbError(error.message) ?? errorResponse("heartbeat_failed", 500, error, workspaceId, sessionId);

  // The host says which model and effort it ended up on. The session's own host machine is the only one that may.
  const agent = await reportedAgent(sessionId, workspaceId, hostId, parsed.body);
  if (agent) return agent;
  return Response.json({ ok: true, status: data });
});

export const END = withHostAuth<EndRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const owned = await authorizeHostSession(workspaceId, sessionId, caller);
  if (!owned.ok) return owned.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const target = hostIdFor(caller, optionalString(parsed.body.hostId, 200));
  if (!target.ok) return target.response;
  if (target.hostId !== owned.session.host_id) return errorResponse("foreign_host", 403);

  const reason = optionalString(parsed.body.reason, 100) ?? "ended";
  const { error } = await serviceClient
    .from("sessions")
    .update({ status: "ended", ended_at: new Date().toISOString(), end_reason: reason, open_approval_count: 0 })
    .eq("id", sessionId)
    .neq("status", "ended");
  if (error) return errorResponse("session_end_failed", 500, error, workspaceId, sessionId);
  await failQueuedInputs(sessionId, reason === "cleared" ? "session_cleared" : "session_ended");

  return Response.json({ ok: true });
});

/**
 * The cloud host says its session is idle and it is stopping. A waiting input refuses the sleep (409 inputs_pending),
 * and the run stays active so the host can deliver it. Otherwise the run succeeds and the session sleeps.
 */
export const HOST_SLEEP = withHostAuth<HostSleepRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  if (caller.kind !== "cloud_host") return errorResponse("cloud_host_only", 403);
  const owned = await authorizeHostSession(workspaceId, sessionId, caller);
  if (!owned.ok) return owned.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const target = hostIdFor(caller, optionalString(parsed.body.hostId, 200));
  if (!target.ok) return target.response;

  const status = owned.session.status;
  if (!SLEEPABLE_STATUSES.includes(status)) return errorResponse(status === "ended" ? "session_ended" : "session_sleeping", 409);

  const outcome = await sleepCloudSession(
    { workspaceId, sessionId, runId: caller.runId },
    { client: serviceClient, wake: (session) => wakeCloudSession(session, productionStartDeps()) },
  );
  switch (outcome) {
    case "sleeping":
      return Response.json({ ok: true, status: "sleeping" });
    case "inputs_pending":
      return errorResponse("inputs_pending", 409);
    case "session_changed":
      return errorResponse("session_changed", 409);
    case "failed":
      return Response.json({ ok: false, error: "session_sleep_failed" }, { status: 500 });
  }
});

/**
 * Hides the owner's session from every viewer. A live session ends first, so its host stops.
 * Nothing on the owner's computer is removed.
 */
export const DELETE = withAuth<DeleteRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const owned = await authorizeOwned(workspaceId, sessionId, caller.userId);
  if (!owned.ok) return owned.response;
  if (owned.session.session_type !== "interactive") return errorResponse("routine_read_only", 409);

  const now = new Date().toISOString();
  const ending = owned.session.status === "ended" ? {} : { status: "ended", ended_at: now, end_reason: "deleted", open_approval_count: 0 };
  const { error } = await serviceClient.from("sessions").update({ ...ending, deleted_at: now }).eq("id", sessionId).is("deleted_at", null);
  if (error) return errorResponse("session_delete_failed", 500, error, workspaceId, sessionId);
  await failQueuedInputs(sessionId, "session_ended");
  const snapshotKey = snapshotKeyOf(owned.session.seed);
  if (snapshotKey) await discardSnapshot(storageSnapshotStore(serviceClient), snapshotKey, { client: serviceClient, workspaceId, sessionId });

  return Response.json({ ok: true });
});

/** The owner continues an ended session on the computer it ran on. It is the same session, live again. */
export const REOPEN = withAuth<ReopenRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const owned = await authorizeOwned(workspaceId, sessionId, caller.userId);
  if (!owned.ok) return owned.response;

  // A cloud session's volume is removed once it ends, so it cannot be reopened.
  if (owned.session.runtime === "cloud") return errorResponse("cloud_session_ended", 409);

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  if (optionalString(parsed.body.hostId, 200) !== owned.session.host_id) return errorResponse("foreign_host", 403);

  const { session } = owned;
  if (session.session_type !== "interactive") return errorResponse("routine_read_only", 409);
  if (session.status !== "ended") return Response.json({ ok: true, session });
  if (session.end_reason === "cleared") return errorResponse("session_cleared", 409);

  const { data, error } = await serviceClient
    .from("sessions")
    .update({ status: "live", ended_at: null, end_reason: null, last_seen: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("status", "ended")
    .select(SESSION_COLUMNS)
    .maybeSingle<SessionRow>();
  if (error) return errorResponse("session_reopen_failed", 500, error, workspaceId, sessionId);
  return Response.json({ ok: true, session: data ?? { ...session, status: "live" } });
});

export const RAW_UPLOAD_URLS = withHostAuth<RawRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const owned = await authorizeHostSession(workspaceId, sessionId, caller);
  if (!owned.ok) return owned.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const target = hostIdFor(caller, optionalString(parsed.body.hostId, 200));
  if (!target.ok) return target.response;
  if (target.hostId !== owned.session.host_id) return errorResponse("foreign_host", 403);

  const files = parsed.body.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > 200 || !files.every((f) => typeof f === "string" && RAW_FILE.test(f))) {
    return errorResponse("invalid_files", 400);
  }

  const uploads = [];
  for (const file of files as string[]) {
    const objectPath = `${workspaceId}/${sessionId}/${file}.gz`;
    const { data, error } = await serviceClient.storage.from(RAW_BUCKET).createSignedUploadUrl(objectPath, { upsert: true });
    if (error || !data) return errorResponse("upload_url_failed", 500, error, workspaceId, sessionId);
    uploads.push({ file, signedUrl: data.signedUrl });
  }
  return Response.json({ ok: true, uploads });
});

export const RAW_UPLOAD_COMPLETE = withHostAuth<RawCompleteRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const owned = await authorizeHostSession(workspaceId, sessionId, caller);
  if (!owned.ok) return owned.response;

  const parsed = await readBody(req);
  if (!parsed.ok) return parsed.response;
  const target = hostIdFor(caller, optionalString(parsed.body.hostId, 200));
  if (!target.ok) return target.response;
  if (target.hostId !== owned.session.host_id) return errorResponse("foreign_host", 403);

  const prefix = `${workspaceId}/${sessionId}`;
  const { data: objects, error: listError } = await serviceClient.storage.from(RAW_BUCKET).list(prefix);
  if (listError) return errorResponse("raw_list_failed", 500, listError, workspaceId, sessionId);
  if (!objects?.some((o) => o.name === "root.jsonl.gz")) return errorResponse("raw_not_uploaded", 409);

  const { error } = await serviceClient
    .from("sessions")
    .update({ raw_storage_path: `${prefix}/`, raw_uploaded_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (error) return errorResponse("raw_record_failed", 500, error, workspaceId, sessionId);

  return Response.json({ ok: true });
});

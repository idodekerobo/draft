import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { defineTool, refuse } from "../tool-registry";
import { requireUser } from "./shared";

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 100;
const READ_MAX_LIMIT = 100;

type SessionCursor = { v: 1; binding: string; started_at: string; id: string };

function cursorBinding(filters: { provider: string | null; since: string | null; until: string | null }): string {
  return createHash("sha256").update(JSON.stringify(filters)).digest("base64url");
}

function parseCursor(value: string, binding: string): SessionCursor | null {
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (cursor.v !== 1 || cursor.binding !== binding || typeof cursor.started_at !== "string" ||
        Number.isNaN(Date.parse(cursor.started_at)) || typeof cursor.id !== "string" ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(cursor.id)) return null;
    return { ...(cursor as SessionCursor), started_at: new Date(cursor.started_at).toISOString() };
  } catch {
    return null;
  }
}

function normalizeDate(value: string | undefined): string | null | false {
  if (!value) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(date.getTime()) ? false : date.toISOString();
}

export function createSessionTools(client: SupabaseClient) {
  const list = defineTool({
    name: "sessions.list",
    mcp: true,
    allowedOrigins: ["person"],
    description: "List interactive conversations created in the Draft app, newest first. Filter by harness/provider (for example codex) and date; pass next_cursor as cursor to continue. Captured coding sessions are source items; use sources.list with type coding_session for those.",
    input: z.object({
      provider: z.string().optional().describe("Harness id, such as claude or codex."),
      since: z.string().optional().describe("Inclusive UTC date or timestamp."),
      until: z.string().optional().describe("Exclusive UTC date or timestamp."),
      limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional(),
      cursor: z.string().optional(),
    }),
    auditArguments: ({ cursor, ...input }) => ({ ...input, cursor: cursor ? "[redacted]" : undefined }),
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "sessions.list");
      const since = normalizeDate(input.since);
      const until = normalizeDate(input.until);
      if (since === false || until === false || (since && until && since >= until)) {
        return refuse("invalid_filter", "Use valid dates with since earlier than until.");
      }
      const filters = { provider: input.provider ?? null, since, until };
      const binding = cursorBinding(filters);
      const cursor = input.cursor ? parseCursor(input.cursor, binding) : null;
      if (input.cursor && !cursor) return refuse("invalid_cursor", "That cursor is invalid or belongs to different filters.");

      let query = client.from("sessions")
        .select("id, harness, model, title, status, started_at, ended_at, last_event_at, folder_name, owner_user_id")
        .eq("workspace_id", user.workspaceId)
        .eq("session_type", "interactive")
        .is("deleted_at", null)
        // Another person's Home is dropped here, before the page limit.
        .or(`is_home.eq.false,owner_user_id.eq.${user.userId}`)
        .order("started_at", { ascending: false })
        .order("id", { ascending: false });
      if (filters.provider) query = query.eq("harness", filters.provider);
      if (since) query = query.gte("started_at", since);
      if (until) query = query.lt("started_at", until);
      if (cursor) query = query.or(`started_at.lt.${cursor.started_at},and(started_at.eq.${cursor.started_at},id.lt.${cursor.id})`);
      const limit = input.limit ?? LIST_DEFAULT_LIMIT;
      const { data, error } = await query.limit(limit + 1);
      if (error) throw new Error("App session listing failed.");

      const rows = (data ?? []) as Array<Record<string, unknown>>;
      const sessions = rows.slice(0, limit).map(({ owner_user_id, ...row }) => ({ ...row, mine: owner_user_id === user.userId }));
      const last = rows.length > limit ? rows[limit - 1] : null;
      const nextCursor = last ? Buffer.from(JSON.stringify({
        v: 1, binding, started_at: last.started_at, id: last.id,
      }), "utf8").toString("base64url") : null;
      return { status: "ok" as const, output: { sessions, next_cursor: nextCursor, filters } };
    },
  });

  const read = defineTool({
    name: "sessions.read",
    mcp: true,
    allowedOrigins: ["person"],
    description: "Read a Draft app conversation and a page of its events. Pass next_after_seq as after_seq to continue. For captured coding session transcripts, use sources.read with representation transcript.",
    input: z.object({
      session_id: z.string().uuid(),
      after_seq: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(READ_MAX_LIMIT).optional(),
    }),
    handler: async ({ input, caller }) => {
      const user = requireUser(caller, "sessions.read");
      const { data: session, error: sessionError } = await client.from("sessions")
        .select("id, harness, model, title, status, started_at, ended_at, end_reason, last_event_at, folder_name, git_remote, harness_version, is_home, owner_user_id")
        .eq("id", input.session_id)
        .eq("workspace_id", user.workspaceId)
        .eq("session_type", "interactive")
        .is("deleted_at", null)
        .maybeSingle();
      if (sessionError) throw new Error("App session read failed.");
      // A Home session is its owner's alone, and anyone else is told it does not exist.
      const { is_home: isHome, owner_user_id: ownerUserId, ...visible } = (session ?? {}) as Record<string, unknown>;
      if (!session || (isHome && ownerUserId !== user.userId)) return refuse("session_not_found", "Draft app session not found.");

      const after = input.after_seq ?? 0;
      const limit = input.limit ?? READ_MAX_LIMIT;
      const { data: events, error: eventsError } = await client.from("session_events")
        .select("seq, kind, payload, created_at")
        .eq("session_id", input.session_id)
        .eq("workspace_id", user.workspaceId)
        .gt("seq", after)
        .order("seq", { ascending: true })
        .limit(limit + 1);
      if (eventsError) throw new Error("App session events read failed.");
      const rows = events ?? [];
      const page = rows.slice(0, limit);
      return {
        status: "ok" as const,
        output: { session: visible, events: page, next_after_seq: rows.length > limit ? page.at(-1)?.seq ?? null : null },
      };
    },
  });

  return [list, read];
}

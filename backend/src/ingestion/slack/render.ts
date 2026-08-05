import type { SupabaseClient } from "@supabase/supabase-js";
import type { SlackMessageFileRef, SlackMessageRow } from "./types";

// ── Thread grouping ───────────────────────────────────────────────────────────

interface Thread {
  thread_ts: string;
  messages: SlackMessageRow[];
}

// thread_ts === message_ts is a thread root; thread_ts set but different is
// a reply; thread_ts null/absent is standalone.
function groupByThread(messages: SlackMessageRow[]): {
  threads: Thread[];
  standalone: SlackMessageRow[];
} {
  const threadMap = new Map<string, SlackMessageRow[]>();

  for (const msg of messages) {
    const key =
      msg.thread_ts && msg.thread_ts !== msg.message_ts ? msg.thread_ts : msg.message_ts;
    if (!threadMap.has(key)) threadMap.set(key, []);
    threadMap.get(key)!.push(msg);
  }

  const threads: Thread[] = [];
  const standalone: SlackMessageRow[] = [];

  for (const [thread_ts, msgs] of threadMap.entries()) {
    const sorted = [...msgs].sort((a, b) => a.message_ts.localeCompare(b.message_ts));
    // A thread has >1 message, or has replies (messages with this thread_ts
    // pointing at it from others).
    const hasReplies = messages.some(
      (m) => m.thread_ts === thread_ts && m.message_ts !== thread_ts,
    );
    if (sorted.length > 1 || hasReplies) {
      threads.push({ thread_ts, messages: sorted });
    } else {
      standalone.push(sorted[0]!);
    }
  }

  threads.sort((a, b) => a.messages[0]!.message_ts.localeCompare(b.messages[0]!.message_ts));
  standalone.sort((a, b) => a.message_ts.localeCompare(b.message_ts));

  return { threads, standalone };
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function tsToTime(ts: string): string {
  return new Date(parseFloat(ts) * 1000).toISOString().slice(11, 16);
}

function tsToDate(ts: string): string {
  return new Date(parseFloat(ts) * 1000).toISOString().slice(0, 10);
}

function displayName(msg: SlackMessageRow): string {
  return msg.user_name_snapshot ?? msg.slack_user_id ?? "unknown-user";
}

/** Renders reactions inline in a form a synthesis-reading LLM can parse as
 * "this message got these reactions". */
function renderReactions(reactionsJson: unknown[]): string {
  if (!reactionsJson || reactionsJson.length === 0) return "";
  const parts = reactionsJson.map((r) => {
    const reaction = r as { name?: string; count?: number };
    const name = reaction.name ?? "reaction";
    const count = reaction.count ?? 1;
    return `:${name}: ×${count}`;
  });
  return `Reactions: ${parts.join("  ")}`;
}

/** Renders file attachments as pointers to the durable object key -- never a
 * local filesystem path, never a signed/download URL. */
function renderFiles(files: SlackMessageFileRef[]): string {
  if (!files || files.length === 0) return "";
  return files
    .map((f) => `📎 **${f.name}** → \`${f.object_key}\``)
    .join("\n");
}

function renderBody(msg: SlackMessageRow): string[] {
  const lines: string[] = [];
  if (msg.is_deleted) {
    lines.push("[deleted]");
    return lines;
  }
  if (msg.text) lines.push(msg.text);
  const rxns = renderReactions(msg.reactions_json);
  if (rxns) lines.push(rxns);
  const files = renderFiles(msg.files_json);
  if (files) lines.push(files);
  return lines;
}

function renderMessage(msg: SlackMessageRow): string {
  const name = displayName(msg);
  const time = tsToTime(msg.message_ts);
  const lines: string[] = [`**${name}** [${time}]`, ...renderBody(msg)];
  return lines.join("\n");
}

function renderReply(msg: SlackMessageRow): string {
  const name = displayName(msg);
  const time = tsToTime(msg.message_ts);
  const body = renderBody(msg).map((line) => `  ${line.replace(/\n/g, "\n  ")}`);
  const lines: string[] = [`  ↳ **${name}** [${time}]`, ...body];
  return lines.join("\n");
}

// ── Data access ────────────────────────────────────────────────────────────────

async function fetchMessages(
  db: SupabaseClient,
  messageIds: string[],
): Promise<SlackMessageRow[]> {
  const { data, error } = await db.from("slack_messages").select("*").in("id", messageIds);
  if (error) throw error;
  return (data ?? []) as SlackMessageRow[];
}

// ── Main render ────────────────────────────────────────────────────────────────

export async function renderSlackMessages(
  messageIds: string[],
  client?: SupabaseClient,
): Promise<string> {
  if (messageIds.length === 0) return "";

  const db = client ?? (await import("../../db/client")).serviceClient;
  const rawMessages = await fetchMessages(db, messageIds);

  // Sort by message_ts ascending ourselves -- don't trust caller order, and
  // don't trust the order rows come back from Postgres.
  const messages = [...rawMessages].sort((a, b) => a.message_ts.localeCompare(b.message_ts));

  if (messages.length === 0) return "";

  const { threads, standalone } = groupByThread(messages);

  const channelName = messages.find((m) => m.channel_name_snapshot)?.channel_name_snapshot;
  const channelId = messages[0]!.channel_id;
  const participants = [...new Set(messages.map((m) => displayName(m)))].join(", ");
  const earliest = messages[0]!;
  const latest = messages[messages.length - 1]!;
  const period = `${tsToDate(earliest.message_ts)} ${tsToTime(earliest.message_ts)} → ${tsToDate(
    latest.message_ts,
  )} ${tsToTime(latest.message_ts)}`;

  const sections: string[] = [
    `# #${channelName ?? channelId} — ${tsToDate(earliest.message_ts)}`,
    "",
    `**Channel ID:** ${channelId}`,
    `**Period:** ${period}`,
    `**Participants:** ${participants}`,
    `**Messages:** ${messages.length}`,
    "",
    "---",
  ];

  // Build reply map: thread root ts -> reply messages (everything after root)
  const replyMap = new Map<string, SlackMessageRow[]>();
  for (const t of threads) {
    replyMap.set(t.thread_ts, t.messages.slice(1));
  }

  // Render all root messages in chronological order; nest replies inline.
  const roots: SlackMessageRow[] = [
    ...threads.map((t) => t.messages[0]).filter((m): m is SlackMessageRow => m !== undefined),
    ...standalone,
  ].sort((a, b) => a.message_ts.localeCompare(b.message_ts));

  for (const root of roots) {
    sections.push("");
    sections.push(renderMessage(root));

    const replies = replyMap.get(root.message_ts) ?? [];
    for (const reply of replies) {
      sections.push("");
      sections.push(renderReply(reply));
    }
  }

  return sections.join("\n");
}

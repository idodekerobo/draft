#!/usr/bin/env bun
/**
 * slack-rebuild.ts — Thread reconstruction for Draft Slack synthesis
 *
 * Reads JSONL files for a channel over a time window and produces a
 * human-readable markdown file organized by thread. Called by slack-analyzer.sh
 * before synthesis. Output file path is printed to stdout for the caller.
 *
 * Usage:
 *   bun run slack-rebuild.ts --channel <id> --channel-name <name> --hours <N> --capture-dir <dir>
 *
 * Stdout: absolute path to reconstructed markdown file
 * Stderr: log lines
 * Exit 0: success (file written, or no messages — stdout will be empty if no messages)
 * Exit 1: error
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { SlackMessage, SlackUsers } from './types.ts';

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const CHANNEL_ID   = getArg('--channel')      ?? '';
const CHANNEL_NAME = getArg('--channel-name') ?? CHANNEL_ID;
const HOURS        = parseInt(getArg('--hours') ?? '8', 10);
const CAPTURE_DIR  = getArg('--capture-dir')
  ?? join(process.env.DRAFT_BACKGROUND ?? join(process.env.HOME!, '.draft', 'background'), 'integrations', 'slack', 'captures');
const DRAFT_WORKSPACE = process.env.DRAFT_WORKSPACE ?? '';

if (!CHANNEL_ID) {
  process.stderr.write('slack-rebuild: --channel is required\n');
  process.exit(1);
}

// ── User resolution ───────────────────────────────────────────────────────────

function loadUsers(): SlackUsers {
  const usersFile = join(DRAFT_WORKSPACE, 'config', 'slack-roles.json');
  if (!existsSync(usersFile)) return {};
  try { return JSON.parse(readFileSync(usersFile, 'utf8')); }
  catch { return {}; }
}

function resolveDisplayName(userId: string, users: SlackUsers): string {
  const u = users[userId] as { name?: string; role?: string } | undefined;
  if (!u) return userId;
  return u.role ? `${u.name} (${u.role})` : (u.name ?? userId);
}

function resolveChannelName(channelId: string, users: SlackUsers): string {
  const channels = users['__channels'] as Record<string, string> | undefined;
  return channels?.[channelId] ?? channelId;
}

// ── JSONL reading ─────────────────────────────────────────────────────────────

function parseJsonlFile(path: string): SlackMessage[] {
  try {
    const content = readFileSync(path, 'utf8').trim();
    if (!content) return [];
    return content.split('\n').flatMap(line => {
      try { return [JSON.parse(line) as SlackMessage]; }
      catch { return []; }
    });
  } catch {
    return [];
  }
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function loadMessages(channelId: string, sinceHours: number): SlackMessage[] {
  const cutoffTs = ((Date.now() - sinceHours * 3600 * 1000) / 1000).toFixed(6);

  // Read today + yesterday (covers any window up to 48h)
  const today     = dateStr(new Date());
  const yesterday = dateStr(new Date(Date.now() - 86_400_000));

  const files = [yesterday, today]
    .map(d => join(CAPTURE_DIR, channelId, `${d}.jsonl`))
    .filter(existsSync);

  const all = files.flatMap(parseJsonlFile);
  return all.filter(m => m.ts >= cutoffTs).sort((a, b) => a.ts.localeCompare(b.ts));
}

// ── Noise filter ──────────────────────────────────────────────────────────────

function isNoise(msg: SlackMessage): boolean {
  // No text, no files, no reactions = nothing to synthesize (e.g. system join events)
  // Note: unknown user_id is kept — departed teammates' messages are still signal
  if (!msg.text && !msg.files.length && !msg.reactions.length) return true;
  return false;
}

// ── Thread grouping ───────────────────────────────────────────────────────────

interface Thread {
  thread_ts: string;
  messages: SlackMessage[];
}

function groupByThread(messages: SlackMessage[]): { threads: Thread[]; standalone: SlackMessage[] } {
  const threadMap = new Map<string, SlackMessage[]>();

  for (const msg of messages) {
    const key = msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : msg.ts;
    if (!threadMap.has(key)) threadMap.set(key, []);
    threadMap.get(key)!.push(msg);
  }

  const threads: Thread[]       = [];
  const standalone: SlackMessage[] = [];

  for (const [thread_ts, msgs] of threadMap.entries()) {
    const sorted = msgs.sort((a, b) => a.ts.localeCompare(b.ts));
    // A thread has >1 message, or has replies (messages with this thread_ts from others)
    const hasReplies = messages.some(m => m.thread_ts === thread_ts && m.ts !== thread_ts);
    if (sorted.length > 1 || hasReplies) {
      threads.push({ thread_ts, messages: sorted });
    } else {
      standalone.push(sorted[0]);
    }
  }

  threads.sort((a, b) => a.messages[0].ts.localeCompare(b.messages[0].ts));
  standalone.sort((a, b) => a.ts.localeCompare(b.ts));

  return { threads, standalone };
}

// ── Markdown rendering ────────────────────────────────────────────────────────

function tsToTime(ts: string): string {
  return new Date(parseFloat(ts) * 1000).toISOString().slice(11, 16);
}

function tsToDate(ts: string): string {
  return new Date(parseFloat(ts) * 1000).toISOString().slice(0, 10);
}

function renderReactions(reactions: SlackMessage['reactions']): string {
  if (!reactions.length) return '';
  return reactions
    .map(r => `${r.name === 'white_check_mark' ? '✅' : `:${r.name}:`} ×${r.count}`)
    .join('  ');
}

function renderFiles(files: SlackMessage['files']): string {
  if (!files.length) return '';
  return files.map(f => {
    const abs  = join(CAPTURE_DIR, f.local_path);
    const text = f.text_path ? `\n   Text: \`${join(CAPTURE_DIR, f.text_path)}\`` : '';
    return `📎 **${f.name}** → \`${abs}\`` + text;
  }).join('\n');
}

function renderMessage(msg: SlackMessage, users: SlackUsers): string {
  const name  = resolveDisplayName(msg.user_id, users);
  const time  = tsToTime(msg.ts);
  const lines: string[] = [`**${name}** [${time}]`];
  if (msg.text) lines.push(msg.text);
  const rxns = renderReactions(msg.reactions);
  if (rxns) lines.push(rxns);
  const files = renderFiles(msg.files);
  if (files) lines.push(files);
  return lines.join('\n');
}

function renderReply(msg: SlackMessage, users: SlackUsers): string {
  const name  = resolveDisplayName(msg.user_id, users);
  const time  = tsToTime(msg.ts);
  const lines: string[] = [`  ↳ **${name}** [${time}]`];
  if (msg.text) lines.push(`  ${msg.text.replace(/\n/g, '\n  ')}`);
  const rxns = renderReactions(msg.reactions);
  if (rxns) lines.push(`  ${rxns}`);
  const files = renderFiles(msg.files);
  if (files) lines.push(files);
  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const users      = loadUsers();
  const rawMessages = loadMessages(CHANNEL_ID, HOURS);
  const messages    = rawMessages.filter(m => !isNoise(m));
  const filteredCount = rawMessages.length - messages.length;

  if (messages.length === 0) {
    process.stderr.write(`slack-rebuild: no messages for ${CHANNEL_ID} in last ${HOURS}h\n`);
    process.exit(0); // exit 0, empty stdout = no file to pass to synthesizer
  }

  const resolvedName = resolveChannelName(CHANNEL_ID, users) || CHANNEL_NAME;
  const { threads, standalone } = groupByThread(messages);

  const participantIds = [...new Set(messages.map(m => m.user_id))];
  const participants   = participantIds.map(id => resolveDisplayName(id, users)).join(', ');
  const earliest = messages[0];
  const latest   = messages[messages.length - 1];
  const period   = `${tsToDate(earliest.ts)} ${tsToTime(earliest.ts)} → ${tsToDate(latest.ts)} ${tsToTime(latest.ts)}`;

  const sections: string[] = [
    `# #${resolvedName} — ${tsToDate(earliest.ts)}`,
    '',
    `**Channel ID:** ${CHANNEL_ID}`,
    `**Period:** ${period} (last ${HOURS}h)`,
    `**Reconstructed at:** ${new Date().toISOString()}`,
    `**Participants:** ${participants}`,
    `**Messages:** ${messages.length}  |  **Filtered (empty):** ${filteredCount}`,
    '',
    '---',
  ];

  // Build reply map: thread root ts → reply messages (everything after root)
  const replyMap = new Map<string, SlackMessage[]>();
  for (const t of threads) {
    replyMap.set(t.thread_ts, t.messages.slice(1));
  }

  // Render all root messages in chronological order; nest replies inline
  const roots: SlackMessage[] = [
    ...threads.map(t => t.messages[0]),
    ...standalone,
  ].sort((a, b) => a.ts.localeCompare(b.ts));

  roots.forEach(root => {
    sections.push('');
    sections.push(renderMessage(root, users));

    const replies = replyMap.get(root.ts) ?? [];
    replies.forEach(reply => {
      sections.push('');
      sections.push(renderReply(reply, users));
    });
  });

  const markdown = sections.join('\n');

  // Write reconstructed file
  const outDir  = join(CAPTURE_DIR, CHANNEL_ID, 'reconstructed');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${dateStr(new Date())}.md`);
  writeFileSync(outPath, markdown, 'utf8');

  // Print output path to stdout for caller (slack-analyzer.sh)
  process.stdout.write(outPath + '\n');
}

main();

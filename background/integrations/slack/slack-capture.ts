#!/usr/bin/env bun
/**
 * slack-capture.ts — Draft Slack Socket Mode capture process
 *
 * Long-running process managed by slack-manager.sh (launched by draft-daemon.sh).
 * Connects to Slack via Socket Mode WebSocket — no public URL needed.
 * Writes captured messages to background/integrations/slack/captures/<channel_id>/YYYYMMDD.jsonl
 * Downloads file attachments to background/integrations/slack/captures/<channel_id>/files/
 *
 * Environment (inherited from slack-manager.sh via config.sh):
 *   DRAFT_BACKGROUND  — ~/.draft/background
 *   DRAFT_WORKSPACE   — ~/.draft/workspaces/<profile>
 *   DRAFT_SECRETS     — path to config/secrets.json
 *
 * Capture modes (slack_capture_mode in config/secrets.json):
 *   passive — capture all messages in allowlisted channels (default)
 *   tagged  — capture only messages containing !draft
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { SlackMessage, SlackFile, SlackState, SlackSecrets, SlackUsers } from './types.ts';

// ── Config from environment ───────────────────────────────────────────────────

const DRAFT_BACKGROUND = process.env.DRAFT_BACKGROUND ?? join(process.env.HOME!, '.draft', 'background');
const DRAFT_WORKSPACE  = process.env.DRAFT_WORKSPACE  ?? '';
const DRAFT_SECRETS    = process.env.DRAFT_SECRETS    ?? join(DRAFT_WORKSPACE, 'config', 'secrets.json');

const CAPTURE_DIR = join(DRAFT_BACKGROUND, 'integrations', 'slack', 'captures');
const STATE_FILE  = join(CAPTURE_DIR, 'state.json');
const USERS_FILE  = join(DRAFT_WORKSPACE, 'config', 'slack-roles.json');

const MAX_FILE_TEXT_BYTES = 50_000; // cap text extraction at 50k chars

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(
    `{"ts":"${ts}","level":"${level}","component":"slack-capture","msg":${JSON.stringify(msg)}}\n`
  );
}

// ── State management ──────────────────────────────────────────────────────────

let state: SlackState = {};
let stateDirty = false;

function loadState(): void {
  if (existsSync(STATE_FILE)) {
    try { state = JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
    catch { state = {}; }
  }
}

function updateState(channelId: string, ts: string): void {
  state[channelId] = { last_ts: ts, last_captured_at: new Date().toISOString() };
  stateDirty = true;
}

function flushState(): void {
  if (!stateDirty) return;
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    stateDirty = false;
  } catch (err) {
    log('error', `failed to flush state: ${err}`);
  }
}

setInterval(flushState, 60_000);

// ── Config loading ────────────────────────────────────────────────────────────

function loadSecrets(): SlackSecrets | null {
  if (!existsSync(DRAFT_SECRETS)) {
    log('error', `secrets.json not found at ${DRAFT_SECRETS}`);
    return null;
  }
  try {
    const d = JSON.parse(readFileSync(DRAFT_SECRETS, 'utf8'));
    if (!d.slack_bot_token || !d.slack_app_token) {
      log('error', 'slack_bot_token or slack_app_token missing from secrets.json');
      return null;
    }
    return {
      slack_bot_token: d.slack_bot_token,
      slack_app_token: d.slack_app_token,
      slack_allowlist_channels: d.slack_allowlist_channels ?? [],
      slack_capture_mode: d.slack_capture_mode ?? 'passive',
    };
  } catch (err) {
    log('error', `failed to parse secrets.json: ${err}`);
    return null;
  }
}

function loadUsers(): SlackUsers {
  if (!existsSync(USERS_FILE)) return {};
  try { return JSON.parse(readFileSync(USERS_FILE, 'utf8')); }
  catch { return {}; }
}

// ── File helpers ──────────────────────────────────────────────────────────────

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

function isTextMimetype(mimetype: string, name: string): boolean {
  if (mimetype.startsWith('text/')) return true;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ['txt', 'md', 'csv', 'json', 'yaml', 'yml', 'toml', 'sh'].includes(ext);
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function channelDir(channelId: string): string {
  return join(CAPTURE_DIR, channelId);
}

function jsonlPath(channelId: string): string {
  return join(channelDir(channelId), `${todayStr()}.jsonl`);
}

function ensureChannelDirs(channelId: string): void {
  mkdirSync(join(channelDir(channelId), 'files'), { recursive: true });
  mkdirSync(join(channelDir(channelId), 'reconstructed'), { recursive: true });
}

// ── File download ─────────────────────────────────────────────────────────────

interface RawSlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
}

async function downloadFile(
  raw: RawSlackFile,
  channelId: string,
  botToken: string
): Promise<SlackFile | null> {
  try {
    const response = await fetch(raw.url_private, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!response.ok) {
      log('warn', `file download failed (${response.status}): ${raw.name}`);
      return null;
    }

    const safeName = sanitizeFilename(raw.name);
    const relPath  = join(channelId, 'files', `${raw.id}-${safeName}`);
    const absPath  = join(CAPTURE_DIR, relPath);

    const buffer = await response.arrayBuffer();
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, Buffer.from(buffer));

    let textPath: string | undefined;
    if (isTextMimetype(raw.mimetype, raw.name)) {
      const text = new TextDecoder().decode(buffer).slice(0, MAX_FILE_TEXT_BYTES);
      const textRelPath = `${relPath}.txt`;
      writeFileSync(join(CAPTURE_DIR, textRelPath), text);
      textPath = textRelPath;
    }

    log('info', `downloaded: ${raw.name} → ${relPath}`);
    return {
      id: raw.id,
      name: raw.name,
      mimetype: raw.mimetype,
      size_bytes: raw.size,
      local_path: relPath,
      text_path: textPath,
      captured_at: new Date().toISOString(),
    };
  } catch (err) {
    log('error', `error downloading ${raw.name}: ${err}`);
    return null;
  }
}

// ── Message handling ──────────────────────────────────────────────────────────

// Subtypes to skip — no product context value
const SKIP_SUBTYPES = new Set([
  'bot_message', 'channel_join', 'channel_leave', 'channel_archive',
  'channel_unarchive', 'channel_name', 'channel_purpose', 'channel_topic',
  'group_join', 'group_leave', 'thread_broadcast',
]);

async function handleMessage(
  event: Record<string, unknown>,
  config: SlackSecrets,
  users: SlackUsers,
): Promise<void> {
  const channelId = event.channel as string;
  const ts        = event.ts as string;
  const subtype   = (event.subtype as string | undefined) ?? null;
  const text      = (event.text as string | undefined) ?? '';
  const userId    = (event.user as string | undefined) ?? 'unknown';

  // Only process allowlisted channels
  if (!config.slack_allowlist_channels.includes(channelId)) return;

  // Skip noise subtypes
  if (subtype && SKIP_SUBTYPES.has(subtype)) return;

  // Tagged mode: only capture if message contains !draft
  if (config.slack_capture_mode === 'tagged' && !text.includes('!draft')) return;

  // Resolve user info from local cache
  const userInfo     = users[userId] as { name?: string; real_name?: string } | undefined;
  const userName     = userInfo?.name      ?? userId;
  const userRealName = userInfo?.real_name ?? userId;

  // Thread metadata
  const rawThreadTs   = (event.thread_ts as string | undefined) ?? null;
  const isThreadRoot  = !rawThreadTs || rawThreadTs === ts;
  const parentUserId  = isThreadRoot ? null : (event.parent_user_id as string | undefined) ?? null;

  ensureChannelDirs(channelId);

  // Download attached files
  const rawFiles = (event.files as RawSlackFile[] | undefined) ?? [];
  const downloadedFiles: SlackFile[] = [];
  for (const raw of rawFiles) {
    const f = await downloadFile(raw, channelId, config.slack_bot_token);
    if (f) downloadedFiles.push(f);
  }

  const message: SlackMessage = {
    event_id:       (event.event_id as string | undefined) ?? `${channelId}-${ts}`,
    channel_id:     channelId,
    channel_name:   channelId, // resolved to name by slack-rebuild.ts via __channels map
    ts,
    thread_ts:      rawThreadTs,
    is_thread_root: isThreadRoot,
    parent_user_id: parentUserId,
    user_id:        userId,
    user_name:      userName,
    user_real_name: userRealName,
    text,
    files:          downloadedFiles,
    reactions:      [], // reactions arrive via separate reaction_added events
    subtype,
    captured_at:    new Date().toISOString(),
  };

  const path = jsonlPath(channelId);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(message) + '\n', 'utf8');

  updateState(channelId, ts);
  log('info', `captured message in ${channelId} ts=${ts}`);
}

// ── Socket Mode connection ────────────────────────────────────────────────────

async function getSocketModeUrl(appToken: string): Promise<string> {
  const response = await fetch('https://slack.com/api/apps.connections.open', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${appToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });
  const data = await response.json() as { ok: boolean; url: string; error?: string };
  if (!data.ok) throw new Error(`apps.connections.open failed: ${data.error}`);
  return data.url;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  loadState();

  // Startup check — exit immediately if Slack is not configured at all.
  // After startup, config is reloaded on every connect attempt so token
  // changes (e.g. from /draft:connect slack) take effect without a restart.
  const initialConfig = loadSecrets();
  if (!initialConfig) {
    log('error', 'Slack not configured — run /draft:connect slack to set up');
    process.exit(1);
  }

  log('info', `starting (mode=${initialConfig.slack_capture_mode} channels=${initialConfig.slack_allowlist_channels.join(',')})`);

  let reconnectDelay = 1_000;

  const connect = async (): Promise<void> => {
    // Reload secrets on every connect attempt — picks up token/channel changes
    // written by /draft:connect slack without needing a process restart.
    const config = loadSecrets();
    if (!config) {
      log('error', `secrets.json missing or invalid — retrying in ${reconnectDelay}ms`);
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 300_000);
        connect().catch(err => log('error', `reconnect error: ${err}`));
      }, reconnectDelay);
      return;
    }

    if (config.slack_allowlist_channels.length === 0) {
      log('warn', 'No channels in allowlist — nothing to capture');
    }

    let users = loadUsers();

    try {
      const url = await getSocketModeUrl(config.slack_app_token);
      const ws  = new WebSocket(url);

      ws.onopen = () => {
        log('info', 'Socket Mode connected');
        reconnectDelay = 1_000;
        users = loadUsers(); // refresh user cache on reconnect
      };

      ws.onmessage = (event: MessageEvent) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(event.data as string); }
        catch { return; }

        // Always acknowledge envelope
        if (msg.envelope_id) {
          ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
        }

        if (msg.type === 'hello') {
          log('info', 'received hello — connection established');
          return;
        }

        if (msg.type === 'disconnect') {
          log('warn', `received disconnect — reconnecting`);
          ws.close();
          return;
        }

        if (msg.type === 'events_api') {
          const payload    = msg.payload as Record<string, unknown>;
          const slackEvent = payload.event as Record<string, unknown> | undefined;
          if (slackEvent?.type === 'message') {
            handleMessage(slackEvent, config, users).catch(err =>
              log('error', `handleMessage error: ${err}`)
            );
          }
        }
      };

      ws.onerror = () => {
        log('error', 'WebSocket error');
      };

      ws.onclose = () => {
        log('warn', `WebSocket closed — reconnecting in ${reconnectDelay}ms`);
        setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 300_000);
          connect().catch(err => log('error', `reconnect error: ${err}`));
        }, reconnectDelay);
      };

    } catch (err) {
      log('error', `connection error: ${err} — retrying in ${reconnectDelay}ms`);
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 300_000);
        connect().catch(e => log('error', `reconnect error: ${e}`));
      }, reconnectDelay);
    }
  };

  // Graceful shutdown — flush state before exit
  process.on('SIGTERM', () => { flushState(); process.exit(0); });
  process.on('SIGINT',  () => { flushState(); process.exit(0); });

  await connect();
}

run().catch(err => {
  log('error', `fatal: ${err}`);
  process.exit(1);
});

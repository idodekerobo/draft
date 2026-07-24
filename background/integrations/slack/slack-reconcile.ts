#!/usr/bin/env bun
/**
 * slack-reconcile.ts — Draft Slack channel-membership reconciliation
 *
 * Fired periodically by draft-background.ts (default: every 30 minutes, via
 * DRAFT_SLACK_CAPTURE). Diffs the bot's real Slack channel memberships
 * (conversations.list) against slack_allowlist_channels in secrets.json.
 *
 * Closes the gap where a channel invited via Slack's own "Add apps" panel
 * never reaches Draft — capture only ever reads the allowlist, so a channel
 * added that way is silently never captured until reconciled here.
 *
 * - Added (bot is now a member of a channel not in the allowlist): merge into
 *   slack_allowlist_channels + slack-roles.json's __channels map, log once.
 * - Kicked (allowlisted channel the bot is no longer a member of): never
 *   auto-remove — capture would silently stop with no way to tell "kicked"
 *   from "temporarily unreachable". Warn once per kick, tracked in
 *   captures/reconcile-state.json so it fires again only after a re-invite +
 *   re-kick cycle, not on every unchanged tick.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { getActiveProfile, getWorkspacePath, readSecrets, writeSecrets, BACKGROUND_DIR } from 'draft-core/config';
import { fetchSlackChannels } from 'draft-core/integrations/slack';

const CAPTURE_DIR    = join(BACKGROUND_DIR, 'integrations', 'slack', 'captures');
const STATE_FILE      = join(CAPTURE_DIR, 'reconcile-state.json');

type ReconcileState = Record<string, 'warned' | 'ok'>;

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, component: 'slack-reconcile', msg })}\n`
  );
}

function readRolesChannels(rolesPath: string): Record<string, string> {
  if (!existsSync(rolesPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(rolesPath, 'utf8')) as Record<string, unknown>;
    const channels = parsed.__channels;
    if (channels && typeof channels === 'object' && !Array.isArray(channels)) {
      return channels as Record<string, string>;
    }
  } catch {}
  return {};
}

function writeRolesChannels(rolesPath: string, channels: Record<string, string>): void {
  let roles: Record<string, unknown> = {};
  if (existsSync(rolesPath)) {
    try { roles = JSON.parse(readFileSync(rolesPath, 'utf8')) as Record<string, unknown>; }
    catch {}
  }
  roles.__channels = channels;
  mkdirSync(dirname(rolesPath), { recursive: true });
  writeFileSync(rolesPath, JSON.stringify(roles, null, 2) + '\n', 'utf8');
}

function readReconcileState(): ReconcileState {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ReconcileState; }
  catch { return {}; }
}

function writeReconcileState(state: ReconcileState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export async function main(): Promise<void> {
  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);

  const secretsResult = readSecrets(workspace);
  const botToken = secretsResult.ok ? secretsResult.secrets.slack_bot_token : undefined;
  if (!botToken) {
    // Slack not configured — exit silently (common before setup)
    return;
  }

  const result = await fetchSlackChannels(botToken);
  if (!result.ok) {
    log('warn', `could not fetch channels: ${result.error}`);
    return;
  }

  const allowlist = new Set(secretsResult.ok ? (secretsResult.secrets.slack_allowlist_channels ?? []) : []);
  const rolesPath = join(workspace, 'config', 'slack-roles.json');
  const rolesChannels = readRolesChannels(rolesPath);
  const state = readReconcileState();

  let allowlistDirty = false;
  let rolesDirty = false;
  let stateDirty = false;

  for (const channel of result.channels) {
    const alreadyAllowlisted = allowlist.has(channel.id);

    if (channel.isMember && !alreadyAllowlisted) {
      allowlist.add(channel.id);
      allowlistDirty = true;
      if (rolesChannels[channel.id] !== channel.name) {
        rolesChannels[channel.id] = channel.name;
        rolesDirty = true;
      }
      if (state[channel.id] !== 'ok') {
        state[channel.id] = 'ok';
        stateDirty = true;
      }
      log('info', `reconciled — added #${channel.name} (bot was invited directly in Slack)`);
      continue;
    }

    if (!alreadyAllowlisted) continue;

    if (channel.isMember) {
      if (state[channel.id] === 'warned') {
        state[channel.id] = 'ok';
        stateDirty = true;
      }
    } else if (state[channel.id] !== 'warned') {
      state[channel.id] = 'warned';
      stateDirty = true;
      log('warn', `bot no longer in #${channel.name} — capture will silently stop for this channel until re-invited`);
    }
  }

  // Private channels drop out of conversations.list entirely once the bot is
  // kicked (unlike public channels, which still list with isMember: false) —
  // so an allowlisted channel absent from the response needs the same
  // warn-once treatment as an explicit isMember: false.
  const seenIds = new Set(result.channels.map((channel) => channel.id));
  for (const channelId of allowlist) {
    if (seenIds.has(channelId)) continue;
    if (state[channelId] === 'warned') continue;
    state[channelId] = 'warned';
    stateDirty = true;
    const name = rolesChannels[channelId] ?? channelId;
    log('warn', `bot no longer in #${name} (or channel is private/deleted and inaccessible) — capture will silently stop for this channel until re-invited`);
  }

  if (allowlistDirty) {
    writeSecrets(workspace, { slack_allowlist_channels: [...allowlist] });
  }
  if (rolesDirty) {
    writeRolesChannels(rolesPath, rolesChannels);
  }
  if (stateDirty) {
    writeReconcileState(state);
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    log('error', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

// core/src/integrations/slack.ts — Slack integration logic
//
// Used by: draft-desktop (RPC handlers), draft-cli (future)
//
// Three layers:
//   1. buildSlackManifestUrl  — reads manifest.json, returns Slack app creation URL
//   2. validateSlackTokenFormat — fast format check (no network)
//      validateSlackTokensWithApi — HTTP validation against Slack API (ported from SKILL.md Step 2)
//   3. fetchSlackChannels — conversations.list (ported from SKILL.md Step 3)
//   4. writeSlackConfig — patch-writes secrets.json + integrations.json
//      readStoredSlackBotToken — reads the already-saved bot token, for flows that don't re-collect it
//      updateSlackChannels — updates the channel allowlist for an already-connected integration
//      writeSlackRolesChannels — merges channel names into slack-roles.json's __channels map

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { readSecrets, writeSecrets, writeIntegrations, readIntegrations, BACKGROUND_DIR } from "../config";

// ── Manifest URL ───────────────────────────────────────────────────────────────

export type SlackManifestResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export function buildSlackManifestUrl(backgroundDir?: string): SlackManifestResult {
  const dir = backgroundDir ?? BACKGROUND_DIR;
  const manifestPath = join(dir, "integrations", "slack", "manifest.json");
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as unknown;
    const encoded = encodeURIComponent(JSON.stringify(manifest));
    return { ok: true, url: `https://api.slack.com/apps?new_app=1&manifest_json=${encoded}` };
  } catch {
    return {
      ok: false,
      error: "Could not read Slack manifest. Reinstall Draft or create the app manually at https://api.slack.com/apps.",
    };
  }
}

// ── Token format validation (fast, no network) ─────────────────────────────────

export type SlackFormatResult =
  | { ok: true }
  | { ok: false; error: string };

export function validateSlackTokenFormat(botToken: string, appToken: string): SlackFormatResult {
  if (!botToken.startsWith("xoxb-")) return { ok: false, error: "Bot tokens start with xoxb-." };
  if (!appToken.startsWith("xapp-")) return { ok: false, error: "App tokens start with xapp-." };
  return { ok: true };
}

// ── Token API validation (network) ────────────────────────────────────────────

export interface SlackWorkspaceInfo {
  teamName: string;
  botUser: string;
}

export type SlackTokenApiResult =
  | { ok: true; workspace: SlackWorkspaceInfo }
  | { ok: false; error: string };

export async function validateSlackTokensWithApi(
  botToken: string,
  appToken: string,
): Promise<SlackTokenApiResult> {
  let botResp: Response;
  try {
    botResp = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${botToken}` },
    });
  } catch {
    return { ok: false, error: "Network error validating bot token." };
  }

  const botData = await botResp.json() as {
    ok: boolean; team?: string; user?: string; error?: string;
  };
  if (!botData.ok) {
    return { ok: false, error: `Bot token invalid: ${botData.error ?? "unknown"}` };
  }

  let appResp: Response;
  try {
    appResp = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
  } catch {
    return { ok: false, error: "Network error validating app token." };
  }

  const appData = await appResp.json() as { ok: boolean; error?: string };
  if (!appData.ok) {
    const detail = appData.error === "invalid_auth"
      ? "Make sure you installed the app to your workspace before generating the App-Level Token."
      : appData.error ?? "unknown";
    return { ok: false, error: `App token invalid: ${detail}` };
  }

  return {
    ok: true,
    workspace: { teamName: botData.team ?? "unknown", botUser: botData.user ?? "unknown" },
  };
}

// ── Channel fetch ──────────────────────────────────────────────────────────────

export interface SlackChannel {
  id: string;
  name: string;
  memberCount: number;
  isMember: boolean;
}

export type SlackChannelResult =
  | { ok: true; channels: SlackChannel[] }
  | { ok: false; error: string };

export async function fetchSlackChannels(botToken: string): Promise<SlackChannelResult> {
  let resp: Response;
  try {
    resp = await fetch(
      "https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200&exclude_archived=true",
      { headers: { Authorization: `Bearer ${botToken}` } },
    );
  } catch {
    return { ok: false, error: "Network error fetching channels." };
  }

  const data = await resp.json() as {
    ok: boolean;
    channels?: Array<{ id: string; name: string; num_members?: number; is_member?: boolean }>;
    error?: string;
  };

  if (!data.ok) {
    return { ok: false, error: `Could not fetch channels: ${data.error ?? "unknown"}` };
  }

  const channels: SlackChannel[] = (data.channels ?? [])
    .map((c) => ({ id: c.id, name: c.name, memberCount: c.num_members ?? 0, isMember: c.is_member ?? false }))
    .sort((a, b) => b.memberCount - a.memberCount);

  return { ok: true, channels };
}

// ── Config write ───────────────────────────────────────────────────────────────

export interface WriteSlackConfigOpts {
  workspace: string;
  botToken: string;
  appToken: string;
  workspaceName?: string;
  channelIds?: string[];
}

export function writeSlackConfig(opts: WriteSlackConfigOpts): void {
  writeSecrets(opts.workspace, {
    slack_bot_token: opts.botToken,
    slack_app_token: opts.appToken,
    ...(opts.channelIds ? { slack_allowlist_channels: opts.channelIds } : {}),
  });

  const existing = readIntegrations(opts.workspace);
  writeIntegrations(opts.workspace, {
    ...(existing.ok ? existing.integrations : {}),
    slack: {
      connected: true,
      ...(opts.workspaceName ? { workspace: opts.workspaceName } : {}),
      ...(opts.channelIds ? { channels: opts.channelIds.length } : {}),
      last_connected: new Date().toISOString(),
    },
  });
}

/** Read the bot token already saved for this workspace, or undefined if Slack isn't connected. */
export function readStoredSlackBotToken(workspace: string): string | undefined {
  const secrets = readSecrets(workspace);
  return secrets.ok ? secrets.secrets.slack_bot_token : undefined;
}

// ── Update channel allowlist (already-connected integration) ───────────────────

export type UpdateSlackChannelsResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Update slack_allowlist_channels for an already-connected Slack integration —
 * the "Update channels" path, distinct from the initial connectSlack. Uses the
 * bot token already on disk; does not touch stored tokens.
 */
export async function updateSlackChannels(workspace: string, channelIds: string[]): Promise<UpdateSlackChannelsResult> {
  const botToken = readStoredSlackBotToken(workspace);
  if (!botToken) return { ok: false, error: "Slack is not connected yet." };

  writeSecrets(workspace, { slack_allowlist_channels: channelIds });

  const existing = readIntegrations(workspace);
  writeIntegrations(workspace, {
    ...(existing.ok ? existing.integrations : {}),
    slack: {
      ...(existing.ok ? existing.integrations.slack : {}),
      connected: true,
      channels: channelIds.length,
      last_connected: new Date().toISOString(),
    },
  });

  const listResult = await fetchSlackChannels(botToken);
  if (listResult.ok) {
    const selectedNames = Object.fromEntries(
      listResult.channels
        .filter((channel) => channelIds.includes(channel.id))
        .map((channel) => [channel.id, channel.name]),
    );
    writeSlackRolesChannels(workspace, selectedNames);
  }

  return { ok: true };
}

// ── Channel name map (slack-roles.json's __channels) ────────────────────────────

/**
 * Merge channel ID → name entries into slack-roles.json's __channels map,
 * preserving existing user role entries and any names already recorded there.
 */
export function writeSlackRolesChannels(workspace: string, channels: Record<string, string>): void {
  const rolesPath = join(workspace, "config", "slack-roles.json");
  let roles: Record<string, unknown> = {};
  try {
    roles = JSON.parse(readFileSync(rolesPath, "utf8")) as Record<string, unknown>;
  } catch {}

  const existingChannels = roles.__channels && typeof roles.__channels === "object" && !Array.isArray(roles.__channels)
    ? roles.__channels as Record<string, string>
    : {};

  roles.__channels = { ...existingChannels, ...channels };
  mkdirSync(join(workspace, "config"), { recursive: true });
  writeFileSync(rolesPath, JSON.stringify(roles, null, 2) + "\n", "utf8");
}

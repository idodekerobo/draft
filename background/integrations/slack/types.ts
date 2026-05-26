// types.ts — Shared TypeScript types for Draft Slack integration

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size_bytes: number;
  local_path: string;   // relative to messaging/slack/<channel_id>/
  text_path?: string;   // .txt extraction path, if available
  captured_at: string;  // ISO timestamp
}

export interface SlackReaction {
  name: string;
  count: number;
  users: string[];
}

export interface SlackMessage {
  event_id: string;
  channel_id: string;
  channel_name: string;
  ts: string;
  thread_ts: string | null;
  is_thread_root: boolean;
  parent_user_id: string | null;
  user_id: string;
  user_name: string;
  user_real_name: string;
  text: string;
  files: SlackFile[];
  reactions: SlackReaction[];
  subtype: string | null;
  captured_at: string;
}

export interface SlackUserInfo {
  name: string;
  real_name: string;
  role?: string;
}

// config/slack-roles.json — curator-managed, written by /draft:connect slack
// __channels key stores channel ID → name mapping for slack-rebuild.ts
export type SlackUsers = Record<string, SlackUserInfo | Record<string, string>>;

export interface SlackChannelState {
  last_ts: string;
  last_captured_at: string;
}

// background/messaging/slack/state.json
export type SlackState = Record<string, SlackChannelState>;

export interface SlackSecrets {
  slack_bot_token: string;
  slack_app_token: string;
  slack_allowlist_channels: string[];  // channel IDs, e.g. ["C08product"]
  slack_capture_mode: 'passive' | 'tagged';
}

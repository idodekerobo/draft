import type { SupabaseClient } from "@supabase/supabase-js";
import { createGmailAdapter, type GmailDeps } from "./gmail";
import { createSlackAdapter, type SlackChannelDeps, type SlackDeps } from "./slack";
import type { ConnectionAdapter } from "./types";

export type { AdapterContext, BrowseInput, BrowseResult, ConnectionAdapter, ConnectionVerb, PostInput, ProviderAction, ReadInput, ScopeInput, SearchInput } from "./types";

export interface ConnectionAdapterDeps {
  slack?: SlackDeps;
  slackChannels?: Partial<SlackChannelDeps>;
  gmail?: GmailDeps;
  /** Tests add providers here. */
  extra?: ReadonlyArray<ConnectionAdapter>;
}

/** Every provider the connections.* tools can answer for. A new provider is one file and one line here. */
export function createConnectionAdapters(client: SupabaseClient, deps: ConnectionAdapterDeps = {}): ConnectionAdapter[] {
  return [
    createSlackAdapter(client, deps.slack, deps.slackChannels),
    createGmailAdapter(client, deps.gmail),
    ...(deps.extra ?? []),
  ];
}

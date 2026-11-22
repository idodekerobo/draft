import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolCaller } from "draft-core/tools";
import type { ToolHandlerResult } from "../tool-registry";

/** The verbs a provider may answer through the connections.* tools, beyond connecting and disconnecting it. */
export type ConnectionVerb = "read" | "post" | "search" | "join" | "leave";

export interface ProviderAction {
  verb: ConnectionVerb;
  description: string;
  /** Field name to what it takes, so connections.list can say what to pass. */
  fields: Record<string, string>;
  /** Only a signed-in person may do this. A run holds a permission for every other verb. */
  personOnly?: boolean;
}

export interface AdapterContext {
  client: SupabaseClient;
  caller: ToolCaller;
}

export interface ReadInput {
  channel?: string;
  limit?: number;
}

export interface PostInput {
  channel?: string;
  text: string;
}

export interface ScopeInput {
  channels?: string[];
}

export interface BrowseInput {
  query?: string;
  limit: number;
  cursor?: string;
}

/** What `connections.list` adds to a provider's row when it is browsed: a page of everything that could be joined. */
export type BrowseResult =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; code: string; error: string };

/**
 * One provider's answers to the connections.* verbs. The shared tools look a provider up here, so a provider is added in
 * its own file and one line in the registry, without editing the tools. A verb the adapter leaves out is refused, and the
 * refusal names the providers that have it.
 */
export interface ConnectionAdapter {
  /** The name a caller passes as `provider` to the verbs. */
  provider: string;
  /** The connections.list row this provider shows under, when it differs from its own name. */
  row?: string;
  /** Said when browsing a provider whose row is not connected. */
  notConnectedMessage: string;
  actions: ReadonlyArray<ProviderAction>;
  read?(context: AdapterContext, input: ReadInput): Promise<ToolHandlerResult>;
  post?(context: AdapterContext, input: PostInput): Promise<ToolHandlerResult>;
  join?(context: AdapterContext, input: ScopeInput): Promise<ToolHandlerResult>;
  leave?(context: AdapterContext, input: ScopeInput): Promise<ToolHandlerResult>;
  /** Everything a person could join, one page at a time. For connections.list with available. */
  browse?(context: AdapterContext, input: BrowseInput): Promise<BrowseResult>;
  /** What connections.list adds to the row of a connected provider, such as the channels Slack's bot has joined. */
  describe?(context: AdapterContext): Promise<Record<string, unknown>>;
  /** What the audit row keeps of a call. Without it, only the provider is kept. */
  audit?(verb: ConnectionVerb, input: Record<string, unknown>): Record<string, unknown>;
}

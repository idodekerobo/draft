import type { SupabaseClient } from "@supabase/supabase-js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import type { AgentRunSpec } from "draft-core/agent-run";
import { CURRENT_CREDENTIAL_KEY_VERSION, encryptCredentialPayload } from "../credentials/crypto";
import { resolveProviderCredentialById } from "../credentials/resolve-provider-credential";
import { ToolUserError, type RegisteredTool } from "./tool-registry";

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_TOOL_NAME_CHARS = 30;
const MAX_SLUG_CHARS = 16;

export interface RemoteToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The part of an MCP client this module uses. Tests supply their own. */
export interface RemoteMcpSession {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
  callTool(request: { name: string; arguments: Record<string, unknown> }, options?: { timeout?: number }): Promise<{ content?: unknown; isError?: boolean }>;
  close(): Promise<void>;
}

export type ConnectRemoteMcp = (url: string, token: string) => Promise<RemoteMcpSession>;

export const connectRemoteMcp: ConnectRemoteMcp = async (url, token) => {
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "draft-gateway", version: "1.0.0" });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return client as unknown as RemoteMcpSession;
};

const PRIVATE_IPV4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./];

/**
 * A remote server must be on the public internet over HTTPS. The gateway calls it from Draft's own
 * network with the person's token, so an address inside that network must never be reachable this way.
 */
export function assertSafeMcpUrl(raw: string, options: { allowLocal?: boolean } = {}): string {
  const url = new URL(raw);
  if (options.allowLocal) return url.toString();
  if (url.protocol !== "https:") throw new Error("A remote MCP server must use HTTPS");
  if (url.username || url.password) throw new Error("A remote MCP server URL must not contain credentials");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("A remote MCP server must be on the public internet");
  }
  if (host.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (host.includes(":") || PRIVATE_IPV4.some((pattern) => pattern.test(host))) throw new Error("A remote MCP server must be on the public internet");
  }
  return url.toString();
}

export interface McpConnectionRow {
  id: string;
  workspace_id: string;
  display_name: string | null;
  connection_key: string;
  status: string;
  credential_id: string | null;
  config_json: { tools?: RemoteToolInfo[] } | null;
  connected_by_user_id: string | null;
}

const CONNECTION_COLUMNS = "id, workspace_id, display_name, connection_key, status, credential_id, config_json, connected_by_user_id";

async function listRemoteTools(connect: ConnectRemoteMcp, url: string, token: string): Promise<RemoteToolInfo[]> {
  const session = await connect(url, token);
  try {
    const { tools } = await session.listTools();
    return tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema }));
  } finally {
    await session.close().catch(() => undefined);
  }
}

export interface CreateMcpConnectionInput {
  workspaceId: string;
  /** The person who connected it. Null makes it a shared connection for the whole workspace. */
  userId: string | null;
  url: string;
  token: string;
  displayName: string;
}

/**
 * Connects a remote MCP server: checks it answers with this token, keeps the token encrypted as a
 * credential, and caches the tool list on the connection so a run's tool list needs no remote call.
 */
export async function createMcpConnection(
  client: SupabaseClient,
  input: CreateMcpConnectionInput,
  options: { connect?: ConnectRemoteMcp; allowLocal?: boolean } = {},
): Promise<{ connectionId: string; tools: RemoteToolInfo[] }> {
  const url = assertSafeMcpUrl(input.url, { allowLocal: options.allowLocal });
  const tools = await listRemoteTools(options.connect ?? connectRemoteMcp, url, input.token);

  const { data: credential, error: credentialError } = await client
    .from("credentials")
    .insert({
      workspace_id: input.workspaceId,
      provider: "mcp",
      label: input.displayName,
      encrypted_payload: encryptCredentialPayload(input.token, CURRENT_CREDENTIAL_KEY_VERSION),
      encryption_key_version: CURRENT_CREDENTIAL_KEY_VERSION,
      status: "active",
      created_by_user_id: input.userId,
    })
    .select("id")
    .single();
  if (credentialError) throw credentialError;
  const credentialId = (credential as { id: string }).id;

  const { data: connection, error: connectionError } = await client
    .from("source_connections")
    .insert({
      workspace_id: input.workspaceId,
      provider: "mcp",
      connection_key: url,
      display_name: input.displayName,
      status: "active",
      credential_id: credentialId,
      config_json: { tools },
      connected_by_user_id: input.userId,
      last_success_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (connectionError) {
    await client.from("credentials").delete().eq("id", credentialId);
    throw connectionError;
  }
  return { connectionId: (connection as { id: string }).id, tools };
}

function slugOf(connection: McpConnectionRow): string {
  const source = connection.display_name ?? new URL(connection.connection_key).hostname;
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SLUG_CHARS).replace(/-+$/g, "");
  return slug || "server";
}

/** The name an agent sees for a remote tool. It names the connection, so two servers' tools never clash. */
export function remoteToolName(slug: string, tool: string): string {
  return `mcp.${slug}.${tool}`;
}

/**
 * Which of a run's connections the person may use for it. A personal connection belongs to its owner and a
 * shared one (no owner) to the whole workspace. A revoked or unfinished connection is never usable.
 */
export async function usableMcpConnections(
  client: SupabaseClient,
  workspaceId: string,
  ownerUserId: string | null,
  connectionIds: ReadonlyArray<string>,
): Promise<McpConnectionRow[]> {
  if (connectionIds.length === 0) return [];
  const { data, error } = await client
    .from("source_connections")
    .select(CONNECTION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("provider", "mcp")
    .eq("status", "active")
    .in("id", [...connectionIds]);
  if (error) throw error;
  return ((data ?? []) as McpConnectionRow[]).filter((row) => row.connected_by_user_id === null || row.connected_by_user_id === ownerUserId);
}

/**
 * The tools a cloud run reaches through its connections, as registry entries. The gateway holds the token
 * and makes the call, so the sandbox never sees either. A run holds a tool only if its environment names the
 * connection and the tool.
 */
export async function remoteToolsForRun(
  client: SupabaseClient,
  run: AgentRunSpec,
  options: { connect?: ConnectRemoteMcp } = {},
): Promise<RegisteredTool[]> {
  if (run.runtime.type !== "cloud" || run.runtime.environment.mcpServers.length === 0) return [];
  const permissions = new Map(run.runtime.environment.mcpServers.map((server) => [server.connectionId as string, server.tools]));

  const { data, error } = await client
    .from("source_connections")
    .select(CONNECTION_COLUMNS)
    .eq("workspace_id", run.workspaceId)
    .eq("provider", "mcp")
    .eq("status", "active")
    .in("id", [...permissions.keys()]);
  if (error) throw error;
  const rows = (data ?? []) as McpConnectionRow[];

  const tools: RegisteredTool[] = [];
  const slugs = new Set<string>();
  for (const row of rows) {
    const allowed = permissions.get(row.id)!;
    let slug = slugOf(row);
    if (slugs.has(slug)) slug = `${slug.slice(0, MAX_SLUG_CHARS - 5)}-${row.id.slice(0, 4)}`;
    slugs.add(slug);

    for (const remote of row.config_json?.tools ?? []) {
      if (allowed !== "all" && !allowed.includes(remote.name)) continue;
      if (remote.name.length > MAX_TOOL_NAME_CHARS) continue;
      tools.push(buildRemoteTool(client, row, slug, remote, options.connect ?? connectRemoteMcp));
    }
  }
  return tools;
}

function buildRemoteTool(client: SupabaseClient, connection: McpConnectionRow, slug: string, remote: RemoteToolInfo, connect: ConnectRemoteMcp): RegisteredTool {
  const name = remoteToolName(slug, remote.name);
  const input = (z as unknown as { fromJSONSchema: (schema: unknown) => z.ZodType }).fromJSONSchema(remote.inputSchema);
  return {
    name,
    // The server's own claim about what a tool does cannot be trusted, so every remote tool counts as a write.
    access: "write",
    description: `[${connection.display_name ?? slug}] ${remote.description}`.trim(),
    callers: ["run"],
    mcp: false,
    inputSchema: input,
    // Held only by a cloud run whose environment names this connection and this tool.
    permission: (run) => {
      if (run.runtime.type !== "cloud") return null;
      const named = run.runtime.environment.mcpServers.find((server) => server.connectionId === connection.id);
      return named && (named.tools === "all" || named.tools.includes(remote.name)) ? {} : null;
    },
    parse(raw) {
      const result = input.safeParse(raw ?? {});
      if (result.success) return { ok: true, value: result.data };
      return { ok: false, issues: result.error.issues.map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`) };
    },
    checkLimits: () => null,
    // Arguments sent to another company's server are kept out of the audit row. Only the tool is recorded.
    auditArguments: () => ({ server: connection.display_name ?? slug, tool: remote.name }),
    async run(_caller, value) {
      const token = await resolveProviderCredentialById(connection.workspace_id, "mcp", connection.credential_id ?? "", client);
      const session = await connect(connection.connection_key, token);
      try {
        const reply = await session.callTool({ name: remote.name, arguments: (value ?? {}) as Record<string, unknown> }, { timeout: CALL_TIMEOUT_MS });
        const text = textOf(reply.content);
        if (reply.isError) throw new ToolUserError(text || "The remote tool reported an error");
        return { status: "ok", output: text, summary: `${connection.display_name ?? slug}: ${remote.name}` };
      } finally {
        await session.close().catch(() => undefined);
      }
    },
  };
}

/** The text of a remote reply. A reply that has other kinds of content is passed on as JSON. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  const allText = content.every((block) => block && typeof block === "object" && (block as { type?: string }).type === "text");
  if (allText) return content.map((block) => String((block as { text?: unknown }).text ?? "")).join("\n");
  return JSON.stringify(content);
}

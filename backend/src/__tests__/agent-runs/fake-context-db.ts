import type { SupabaseClient } from "@supabase/supabase-js";
import { canonicalDocumentsHash, sha256, type ContextDocuments } from "../../synthesis/context-version-files";

export function docs(files: Record<string, string>): ContextDocuments {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [path, { content, sha256: sha256(content) }]));
}

interface FakeVersion {
  id: string;
  version_number: number;
  documents_json: ContextDocuments;
}

/** An in-memory stand-in for the context tables. Its commit_context_write call swaps only if the expected version is current. */
export function createFakeContextDb(initial: Record<string, string> | null) {
  const versions = new Map<string, FakeVersion>();
  let pointer: string | null = null;
  let counter = 0;
  const rpcCalls: Array<Record<string, unknown>> = [];
  const toolCalls: Array<{ tool_name: string; status: string; agent_run_id: string }> = [];
  const inputRequests: Array<Record<string, unknown>> = [];
  const hooks: { beforeCommit?: () => void } = {};

  const addVersion = (documents: ContextDocuments): string => {
    const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
    versions.set(id, { id, version_number: counter, documents_json: documents });
    pointer = id;
    return id;
  };
  if (initial) addVersion(docs(initial));

  const countQuery = (rows: () => unknown[]) => {
    const chain: Record<string, unknown> = {
      eq: () => chain,
      then: (resolve: (value: unknown) => void) => resolve({ count: rows().length, error: null }),
    };
    return chain;
  };

  const client = {
    from: (table: string) => {
      if (table === "workspaces") {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: { current_context_version_id: pointer }, error: null }) }) }) };
      }
      if (table === "workspace_context_versions") {
        return {
          select: () => ({
            eq: (_column: string, id: string) => ({ single: async () => ({ data: versions.get(id) ?? null, error: versions.has(id) ? null : new Error("not found") }) }),
          }),
        };
      }
      if (table === "agent_run_tool_calls") return { select: () => countQuery(() => toolCalls.filter((call) => call.status === "conflict")) };
      if (table === "agent_run_input_requests") {
        return {
          insert: (row: Record<string, unknown>) => {
            inputRequests.push(row);
            return { select: () => ({ single: async () => ({ data: { id: "99999999-9999-4999-8999-999999999999" }, error: null }) }) };
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== "commit_context_write") throw new Error(`Unexpected rpc ${name}`);
      hooks.beforeCommit?.();
      hooks.beforeCommit = undefined;
      rpcCalls.push(args);
      if (args.p_expected_version_id !== pointer) return { data: { status: "stale", current_version_id: pointer }, error: null };
      const documents = args.p_documents_json as ContextDocuments;
      if (args.p_content_hash !== canonicalDocumentsHash(documents)) throw new Error("hash mismatch");
      const id = addVersion(documents);
      return { data: { status: "committed", new_version_id: id, version_number: counter }, error: null };
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    rpcCalls,
    toolCalls,
    inputRequests,
    hooks,
    pointer: () => pointer,
    current: () => (pointer ? versions.get(pointer)!.documents_json : {}),
    /** Another writer lands a new version, as a routine would. */
    writeBehindTheScenes: (files: Record<string, string>) => addVersion({ ...(pointer ? versions.get(pointer)!.documents_json : {}), ...docs(files) }),
    versionCount: () => versions.size,
  };
}

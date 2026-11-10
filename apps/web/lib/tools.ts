import { ApiError } from "@/lib/api-error";

/** Browser code passes apiFetch; server layouts pass a token-based fetcher. */
export type Fetcher = <T>(path: string, init?: RequestInit) => Promise<T>;

/**
 * Calls one of Draft's tools for the signed-in person and returns its output.
 * A tool refuses in its output as `{ error }`; that becomes an ApiError with the same code.
 */
export async function callTool<T>(fetcher: Fetcher, workspaceId: string, name: string, input: unknown = {}): Promise<T> {
  const envelope = await fetcher<{ status: string; output: unknown }>(`/workspaces/${workspaceId}/tools/${name}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  const refusal = (envelope.output as { error?: unknown } | null)?.error;
  if (typeof refusal === "string") throw new ApiError(refusal === "no_context_yet" ? 404 : 400, refusal);
  return envelope.output as T;
}

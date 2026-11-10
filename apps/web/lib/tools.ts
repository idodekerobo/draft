import { decodeToolEnvelope } from "draft-core/tool-envelope";
import { ApiError } from "@/lib/api-error";

/** Browser code passes apiFetch; server layouts pass a token-based fetcher. */
export type Fetcher = <T>(path: string, init?: RequestInit) => Promise<T>;

/**
 * Calls one of Draft's tools for the signed-in person and returns its output.
 * A tool's own refusal becomes an ApiError with its code. A tool that cannot find what was asked for is a 404.
 */
export async function callTool<T>(fetcher: Fetcher, workspaceId: string, name: string, input: unknown = {}): Promise<T> {
  const envelope = await fetcher<unknown>(`/workspaces/${workspaceId}/tools/${name}`, { method: "POST", body: JSON.stringify(input) });
  const outcome = decodeToolEnvelope(envelope);
  if (outcome.ok) return outcome.output as T;
  throw new ApiError(outcome.code === "no_context_yet" ? 404 : 400, outcome.code);
}

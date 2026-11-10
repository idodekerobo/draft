import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api-error";
import { contextQueryOptions } from "./queries";
import { callTool, type Fetcher } from "./tools";

/** A fetcher that answers every call with this envelope, as the backend sends it. */
function fetcherReturning(envelope: unknown, seen: Array<{ path: string; init?: RequestInit }> = []): Fetcher {
  return (async (path: string, init?: RequestInit) => {
    seen.push({ path, init });
    return envelope;
  }) as Fetcher;
}

const ok = (output: unknown) => ({ status: "ok", output });
const refused = (code: string) => ({ status: "refused", code, message: code });

describe("callTool", () => {
  test("posts the input to the tool's path and returns its output", async () => {
    const seen: Array<{ path: string; init?: RequestInit }> = [];
    const output = await callTool(fetcherReturning(ok({ n: 1 }), seen), "ws-1", "context.read", { paths: ["a.md"] });
    expect(output).toEqual({ n: 1 });
    expect(seen[0]!.path).toBe("/workspaces/ws-1/tools/context.read");
    expect(seen[0]!.init).toMatchObject({ method: "POST", body: JSON.stringify({ paths: ["a.md"] }) });
  });

  test("turns a refusal in the output into an ApiError with its code", async () => {
    const error = await callTool(fetcherReturning(refused("no_context_yet")), "ws-1", "context.read").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: "no_context_yet" });
    expect(await callTool(fetcherReturning(refused("skill_not_found")), "ws-1", "skills.read").catch((caught) => caught)).toMatchObject({ status: 400, code: "skill_not_found" });
  });
});

describe("contextQueryOptions", () => {
  const queryFn = (fetcher: Fetcher) => contextQueryOptions("ws-1", fetcher).queryFn as () => Promise<unknown>;

  test("turns the tool's document list into the map the pages use", async () => {
    const snapshot = await queryFn(fetcherReturning(ok({ versionNumber: 4, createdAt: "2026-11-09T00:00:00Z", documents: [{ path: "a.md", content: "A", sha256: "x" }] })))();
    expect(snapshot).toEqual({ versionNumber: 4, createdAt: "2026-11-09T00:00:00Z", documents: { "a.md": { content: "A" } } });
  });

  test("answers null when the workspace has no context yet", async () => {
    expect(await queryFn(fetcherReturning(refused("no_context_yet")))()).toBeNull();
  });
});

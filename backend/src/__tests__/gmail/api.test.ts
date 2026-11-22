import { describe, expect, it } from "bun:test";
import { createGmailApi, GmailApiError } from "../../ingestion/gmail/api";

const instant = { sleep: async () => {}, random: () => 0, maxRetries: 1 };

function recordingFetch(respond: (url: URL) => Response) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: URL | string) => {
    const url = new URL(String(input));
    urls.push(url);
    return respond(url);
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const errorBody = (status: number, reason: string) =>
  new Response(JSON.stringify({ error: { code: status, message: "nope", errors: [{ reason }] } }), { status });

describe("createGmailApi", () => {
  it.each([
    [401, "authError", "unauthorized"],
    [403, "insufficientPermissions", "forbidden"],
    [404, "notFound", "not_found"],
    [429, "rateLimitExceeded", "rate_limited"],
    [403, "userRateLimitExceeded", "rate_limited"],
    [500, "backendError", "request_failed"],
  ])("maps status %d (%s) to %s", async (status, reason, code) => {
    const { fetchImpl } = recordingFetch(() => errorBody(status, reason));
    const error = (await createGmailApi("t", fetchImpl, instant).getMessage("m1").catch((e) => e)) as GmailApiError;
    expect(error).toBeInstanceOf(GmailApiError);
    expect(error.code).toBe(code as GmailApiError["code"]);
    expect(error.message).toContain(reason);
  });

  it("lists message ids with a default page size of 20 and caps it at 100", async () => {
    const { fetchImpl, urls } = recordingFetch(() => new Response(JSON.stringify({ messages: [{ id: "a" }, { id: "b" }], nextPageToken: "p2" })));
    const api = createGmailApi("t", fetchImpl, instant);

    expect(await api.listMessageIds("from:me")).toEqual({ ids: ["a", "b"], nextPageToken: "p2" });
    expect(urls[0]!.searchParams.get("maxResults")).toBe("20");
    expect(urls[0]!.searchParams.get("q")).toBe("from:me");

    await api.listMessageIds("x", { maxResults: 500, pageToken: "p2" });
    expect(urls[1]!.searchParams.get("maxResults")).toBe("100");
    expect(urls[1]!.searchParams.get("pageToken")).toBe("p2");
  });

  it("reads a full thread", async () => {
    const { fetchImpl, urls } = recordingFetch(() => new Response(JSON.stringify({ id: "t1", messages: [{ id: "m1" }, { id: "m2" }] })));
    const thread = await createGmailApi("t", fetchImpl, instant).getThread("t1");
    expect(thread.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
    expect(urls[0]!.pathname).toEndWith("/threads/t1");
    expect(urls[0]!.searchParams.get("format")).toBe("full");
  });

  it("reads an attachment", async () => {
    const { fetchImpl, urls } = recordingFetch(() => new Response(JSON.stringify({ size: 5, data: "aGVsbG8" })));
    expect(await createGmailApi("t", fetchImpl, instant).getAttachment("m1", "att-1")).toEqual({ size: 5, data: "aGVsbG8" });
    expect(urls[0]!.pathname).toEndWith("/messages/m1/attachments/att-1");
  });

  it("sends the access token as a bearer header", async () => {
    let auth = null as string | null;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ id: "m1" }));
    }) as unknown as typeof fetch;
    await createGmailApi("token-1", fetchImpl, instant).getMessage("m1");
    expect(auth).toBe("Bearer token-1");
  });
});

import { describe, expect, test } from "bun:test";
import { DriveApiError, createDriveApi } from "../../ingestion/google-drive/api";

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const urls: URL[] = [];
  const impl = (async (input: URL | string) => {
    urls.push(new URL(String(input)));
    const next = (responses.length > 1 ? responses.shift() : responses[0]) ?? { status: 500 };
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe("createDriveApi", () => {
  test("lists files across all drives with the query", async () => {
    const { impl, urls } = fakeFetch([{ status: 200, body: { files: [{ id: "a" }], nextPageToken: "p2" } }]);
    const result = await createDriveApi("tok", impl, { sleep: async () => {} }).listFiles({ q: "visibility = 'domainCanFind'" });
    expect(result).toEqual({ files: [{ id: "a" }], nextPageToken: "p2" });
    expect(urls[0].searchParams.get("q")).toBe("visibility = 'domainCanFind'");
    expect(urls[0].searchParams.get("corpora")).toBe("allDrives");
    expect(urls[0].searchParams.get("supportsAllDrives")).toBe("true");
  });

  test("pages through comments", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { comments: [{ content: "one" }], nextPageToken: "n" } },
      { status: 200, body: { comments: [{ content: "two" }] } },
    ]);
    const comments = await createDriveApi("tok", impl, { sleep: async () => {} }).listComments("f1");
    expect(comments.map((comment) => comment.content)).toEqual(["one", "two"]);
  });

  test("quotes sheet tab names in batchGet ranges", async () => {
    const { impl, urls } = fakeFetch([{ status: 200, body: { valueRanges: [] } }]);
    await createDriveApi("tok", impl, { sleep: async () => {} }).getSheetValues("s1", ["Bo's tab", "Q4"]);
    expect(urls[0].searchParams.getAll("ranges")).toEqual(["'Bo''s tab'", "'Q4'"]);
  });

  test("lists one shared drive when given a driveId", async () => {
    const { impl, urls } = fakeFetch([{ status: 200, body: { files: [] } }]);
    await createDriveApi("tok", impl, { sleep: async () => {} }).listFiles({ q: "trashed = false", driveId: "d1" });
    expect(urls[0].searchParams.get("corpora")).toBe("drive");
    expect(urls[0].searchParams.get("driveId")).toBe("d1");
  });

  test("lists a folder's children with parents in the fields and quotes the folder id", async () => {
    const { impl, urls } = fakeFetch([{ status: 200, body: { files: [{ id: "c1", parents: ["f'1"] }], nextPageToken: "n" } }]);
    const result = await createDriveApi("tok", impl, { sleep: async () => {} }).listFolderChildren("f'1", "p1");
    expect(result).toEqual({ files: [{ id: "c1", parents: ["f'1"] }], nextPageToken: "n" });
    expect(urls[0].searchParams.get("q")).toBe("'f\\'1' in parents and trashed = false");
    expect(urls[0].searchParams.get("pageToken")).toBe("p1");
    expect(urls[0].searchParams.get("fields")).toContain("parents");
    expect(urls[0].searchParams.get("supportsAllDrives")).toBe("true");
    expect(urls[0].searchParams.get("includeItemsFromAllDrives")).toBe("true");
  });

  test("asks for deleted comments so a delete changes the version", async () => {
    const { impl, urls } = fakeFetch([{ status: 200, body: { comments: [] } }]);
    await createDriveApi("tok", impl, { sleep: async () => {} }).listComments("f1");
    expect(urls[0].searchParams.get("includeDeleted")).toBe("true");
  });

  const cases: Array<[number, unknown, DriveApiError["code"]]> = [
    [401, undefined, "unauthorized"],
    [403, { error: { errors: [{ reason: "forbidden" }] } }, "forbidden"],
    [403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }, "rate_limited"],
    [404, undefined, "not_found"],
    [429, undefined, "rate_limited"],
    [500, undefined, "request_failed"],
  ];
  for (const [status, body, code] of cases) {
    test(`maps status ${status} to ${code}`, async () => {
      const { impl } = fakeFetch([{ status, body }]);
      const error = await createDriveApi("tok", impl, { sleep: async () => {} }).getFile("x").catch((e) => e);
      expect(error).toBeInstanceOf(DriveApiError);
      expect((error as DriveApiError).code).toBe(code);
    });
  }
});

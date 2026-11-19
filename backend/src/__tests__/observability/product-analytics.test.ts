import { describe, expect, it } from "bun:test";
import { captureProductEvent, eventUuid } from "../../observability/product-analytics";

function setup(consent: boolean | null = true) {
  const bodies: Array<Record<string, any>> = [];
  let lookups = 0;
  const query = { select: () => query, eq: () => query, abortSignal: () => query, maybeSingle: async () => {
    lookups++; return { data: { analytics_consent: consent }, error: null };
  } };
  const client = { from: () => query } as never;
  const send = (async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return new Response(null, { status: 200 }); }) as typeof fetch;
  return { bodies, client, send, lookups: () => lookups };
}
const input = { userId: "user", workspaceId: "workspace", key: "routine:1", properties: { routine_id: "routine", source: "mcp" } };

describe("backend product analytics", () => {
  it("uses the consenting user's UUID and stable occurrence IDs", async () => {
    const t = setup();
    for (let i = 0; i < 2; i++) await captureProductEvent(t.client, "routine_created", input, { key: "project", send: t.send });
    expect(t.bodies).toHaveLength(2);
    expect(t.bodies[0]).toMatchObject({ event: "routine_created", distinct_id: "user", properties: { workspace_id: "workspace", source: "mcp", occurrence_id: "routine_created:routine:1" } });
    expect(t.bodies[0]!.uuid).toBe(t.bodies[1]!.uuid);
    expect(eventUuid("other")).not.toBe(t.bodies[0]!.uuid);
  });
  it("sends nothing for opt-out, unknown consent, missing key, or shared work", async () => {
    for (const consent of [false, null]) {
      const t = setup(consent);
      await captureProductEvent(t.client, "routine_created", input, { key: "project", send: t.send });
      expect(t.bodies).toEqual([]);
    }
    const t = setup();
    await captureProductEvent(t.client, "routine_created", input, { key: "", send: t.send });
    await captureProductEvent(t.client, "routine_created", { ...input, userId: null }, { key: "project", send: t.send });
    expect(t.lookups()).toBe(0);
  });
  it("does not fail work when consent lookup or delivery fails", async () => {
    const t = setup();
    await expect(captureProductEvent(t.client, "routine_created", input, { key: "project", send: (async () => { throw new Error("offline"); }) as unknown as typeof fetch })).resolves.toBeUndefined();
    await expect(captureProductEvent({ from: () => { throw new Error("db"); } } as never, "routine_created", input, { key: "project", send: t.send })).resolves.toBeUndefined();
  });
});

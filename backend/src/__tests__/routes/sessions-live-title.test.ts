import { beforeEach, describe, expect, it, mock } from "bun:test";

const ID = "0b9a7a46-6a63-4a53-9a63-0d0c7c6d7a11";
let row: { title: string | null } | null = null;
let lookupError: unknown = null;
const eqs: Array<[string, unknown]> = [];

const builder = {
  select: () => builder,
  eq: (col: string, value: unknown) => { eqs.push([col, value]); return builder; },
  maybeSingle: async () => ({ data: row, error: lookupError }),
};
mock.module("../../db/client", () => ({ serviceClient: { from: () => builder } }));

const { TITLE } = await import("../../routes/sessions-live-title");
const call = (sessionId: string) => TITLE({ params: { sessionId } } as never);

describe("GET /live-session-titles/:sessionId", () => {
  beforeEach(() => { row = null; lookupError = null; eqs.length = 0; });

  it("returns only the title", async () => {
    row = { title: "Fix billing bug" };
    expect(await (await call(ID)).json()).toEqual({ title: "Fix billing bug" });
  });

  it("returns a null title for an unknown session", async () => {
    expect(await (await call(ID)).json()).toEqual({ title: null });
  });

  it("does not query for an id that is not a uuid", async () => {
    expect(await (await call("nope")).json()).toEqual({ title: null });
    expect(eqs).toHaveLength(0);
  });

  it("only reads interactive sessions", async () => {
    await call(ID);
    expect(eqs).toContainEqual(["session_type", "interactive"]);
  });

  it("answers 500 when the lookup fails", async () => {
    lookupError = { message: "boom" };
    expect((await call(ID)).status).toBe(500);
  });
});

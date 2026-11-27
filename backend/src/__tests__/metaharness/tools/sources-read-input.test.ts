import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describeTools } from "../../../metaharness/tools/tool-registry";
import { createSourceTools } from "../../../metaharness/tools/definitions/sources";

const ID = "3f2c1b9e-8a4d-4e6f-9b1a-2c7d5e8f0a11";
const read = createSourceTools({} as SupabaseClient).find((tool) => tool.name === "sources.read")!;

describe("sources.read input", () => {
  it("accepts a plain source id", () => {
    expect(read.parse({ source_item_id: ID })).toEqual({ ok: true, value: { source_item_id: ID } });
  });

  it("drops the position an input file name starts with", () => {
    expect(read.parse({ source_item_id: `0003-${ID}` })).toEqual({ ok: true, value: { source_item_id: ID } });
  });

  it("still rejects text that is not an id", () => {
    expect(read.parse({ source_item_id: "0003-not-an-id" }).ok).toBe(false);
  });

  it("still describes the input as an object schema", () => {
    const [described] = describeTools([read]);
    expect((described.inputSchema as { type: string }).type).toBe("object");
  });
});

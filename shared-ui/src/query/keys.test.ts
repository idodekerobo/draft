import { describe, expect, test } from "bun:test";
import { queryKeys } from "./keys";

describe("queryKeys", () => {
  test("every key is scoped by workspace id first", () => {
    for (const [name, make] of Object.entries(queryKeys)) {
      expect([name, make("ws-1").slice(0, 2)]).toEqual([name, ["ws", "ws-1"]]);
    }
  });

  test("workspace key is a prefix of every resource key", () => {
    const prefix = queryKeys.workspace("ws-1");
    expect(queryKeys.runs("ws-1").slice(0, prefix.length)).toEqual([...prefix]);
  });
});

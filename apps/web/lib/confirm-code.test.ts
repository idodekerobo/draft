import { describe, expect, test } from "bun:test";
import { normalizeConfirmCode } from "./confirm-code";

describe("normalizeConfirmCode", () => {
  test("drops the dash and uppercases what the person typed", () => {
    expect(normalizeConfirmCode("k7m-4qx")).toBe("K7M4QX");
  });

  test("accepts the code without a dash or with stray spaces", () => {
    expect(normalizeConfirmCode("K7M4QX")).toBe("K7M4QX");
    expect(normalizeConfirmCode(" k7m 4qx ")).toBe("K7M4QX");
  });
});

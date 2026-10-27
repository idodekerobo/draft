import { describe, expect, it } from "bun:test";
import { presenceLine } from "./presence-line";

describe("presenceLine", () => {
  it("is empty when nobody else is watching", () => {
    expect(presenceLine([])).toBe("");
  });

  it("names up to three people", () => {
    expect(presenceLine(["Dev"])).toBe("Dev is watching");
    expect(presenceLine(["Dev", "Priya"])).toBe("Dev and Priya are watching");
    expect(presenceLine(["Dev", "Priya", "Sam"])).toBe("Dev, Priya and Sam are watching");
  });

  it("counts the rest after two names", () => {
    expect(presenceLine(["Dev", "Priya", "Sam", "Lee"])).toBe("Dev, Priya and 2 others are watching");
  });
});

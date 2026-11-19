import { describe, expect, it } from "bun:test";
import { displayHostName } from "./host-name";

describe("displayHostName", () => {
  it("shows the product name for a sandbox host and leaves a computer's name alone", () => {
    expect(displayHostName("Draft cloud")).toBe("Draft Cloud");
    expect(displayHostName("Maya's MacBook")).toBe("Maya's MacBook");
    expect(displayHostName(null)).toBeNull();
  });
});

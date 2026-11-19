import { describe, expect, it } from "bun:test";
import { displayHostName } from "./host-name";

describe("displayHostName", () => {
  it("names a cloud session Draft Cloud, even with no stored name, and leaves a computer's name alone", () => {
    expect(displayHostName({ host_name: null, runtime: "cloud" })).toBe("Draft Cloud");
    expect(displayHostName({ host_name: "Draft cloud" })).toBe("Draft Cloud");
    expect(displayHostName({ host_name: "Maya's MacBook", runtime: "local" })).toBe("Maya's MacBook");
    expect(displayHostName({ host_name: null, runtime: "local" })).toBeNull();
  });
});

import { describe, expect, it } from "bun:test";
import { sessionTitle } from "./sessions-list";

describe("sessionTitle", () => {
  it("drops the author tag of a Draft message", () => {
    expect(sessionTitle({ title: "[idode@example.com via Draft] hello", folder_name: "app" })).toBe("hello");
  });

  it("falls back to the folder when there is no title", () => {
    expect(sessionTitle({ title: null, folder_name: "app" })).toBe("New session in app");
    expect(sessionTitle({ title: "[A via Draft] ", folder_name: null })).toBe("New session in a folder");
  });
});

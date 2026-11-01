import { describe, expect, it } from "bun:test";
import { mainNavItems } from "./nav-items";

describe("mainNavItems", () => {
  it("lists the sidebar in the agreed order", () => {
    expect(mainNavItems().map((i) => i.id)).toEqual(["sessions", "routines", "context", "connections", "activity", "settings"]);
  });
});

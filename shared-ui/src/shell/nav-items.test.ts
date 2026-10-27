import { describe, expect, it } from "bun:test";
import { mainNavItems } from "./nav-items";

describe("mainNavItems", () => {
  it("lists the sidebar in the agreed order", () => {
    expect(mainNavItems(true).map((i) => i.id)).toEqual(["context", "sessions", "activity", "routines", "connections", "settings"]);
  });

  it("leaves Sessions out when the workspace has it off", () => {
    expect(mainNavItems(false).map((i) => i.id)).toEqual(["context", "activity", "routines", "connections", "settings"]);
  });
});

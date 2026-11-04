import { describe, expect, it } from "bun:test";
import { buildReadingSources } from "./reading-sources";

describe("buildReadingSources", () => {
  it("skips disconnected and unknown tools", () => {
    const sources = buildReadingSources({ slack: { state: "disconnected" }, github: { state: "connected" } });
    expect(sources.map((source) => source.name)).toEqual(["GitHub"]);
  });

  it("keeps pending and error tools so the wait screen shows them", () => {
    const sources = buildReadingSources({
      linear: { state: "pending", detail: "Setup pending" },
      fireflies: { state: "error", detail: "Needs attention" },
    });
    expect(sources.map((source) => source.name)).toEqual(["Linear", "Fireflies"]);
  });

  it("attaches per-tool detail", () => {
    const sources = buildReadingSources({ slack: { state: "connected" } }, { details: { slack: "Reading 4 channels" } });
    expect(sources[0]?.detail).toBe("Reading 4 channels");
  });

  it("adds an imported folder last", () => {
    const sources = buildReadingSources({ granola: { state: "connected" } }, { folderImported: true });
    expect(sources.map((source) => source.name)).toEqual(["Granola", "Folder"]);
  });

  it("returns nothing when there is nothing to read", () => {
    expect(buildReadingSources({})).toEqual([]);
  });
});

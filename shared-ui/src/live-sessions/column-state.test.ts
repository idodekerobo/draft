import { describe, expect, it } from "bun:test";
import { clampColumnWidth, readColumnState, readRecentFolders, rememberFolder, writeColumnState } from "./column-state";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v), data };
}

describe("clampColumnWidth", () => {
  it("keeps the column between 220 and 400", () => {
    expect(clampColumnWidth(100, 1200)).toBe(220);
    expect(clampColumnWidth(900, 1200)).toBe(400);
    expect(clampColumnWidth(300, 1200)).toBe(300);
  });

  it("leaves the session area at least 360 px", () => {
    expect(clampColumnWidth(400, 700)).toBe(340);
    expect(clampColumnWidth(260, 592)).toBe(232);
  });

  it("never goes below the minimum, even in a tiny window", () => {
    expect(clampColumnWidth(260, 500)).toBe(220);
  });
});

describe("column state storage", () => {
  it("defaults to open at 260", () => {
    expect(readColumnState(memoryStorage())).toEqual({ open: true, width: 260 });
    expect(readColumnState(null)).toEqual({ open: true, width: 260 });
  });

  it("round-trips and ignores a bad width", () => {
    const store = memoryStorage();
    writeColumnState(store, { open: false, width: 310 });
    expect(readColumnState(store)).toEqual({ open: false, width: 310 });
    expect(readColumnState(memoryStorage({ "draft.sessions.columnWidth": "9999" })).width).toBe(260);
    expect(readColumnState(memoryStorage({ "draft.sessions.columnWidth": "abc" })).width).toBe(260);
  });

  it("survives a storage that throws", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readColumnState(broken)).toEqual({ open: true, width: 260 });
    expect(() => writeColumnState(broken, { open: true, width: 260 })).not.toThrow();
  });
});

describe("recent folders", () => {
  it("puts the newest first, moves a repeat up and keeps eight", () => {
    const store = memoryStorage();
    for (let i = 1; i <= 10; i++) rememberFolder(store, `/work/f${i}`);
    expect(readRecentFolders(store).length).toBe(8);
    expect(readRecentFolders(store)[0]).toBe("/work/f10");
    expect(rememberFolder(store, "/work/f5")[0]).toBe("/work/f5");
    expect(readRecentFolders(store).filter((f) => f === "/work/f5").length).toBe(1);
  });

  it("ignores junk in storage", () => {
    expect(readRecentFolders(memoryStorage({ "draft.sessions.recentFolders": "{oops" }))).toEqual([]);
    expect(readRecentFolders(memoryStorage({ "draft.sessions.recentFolders": '[1,"/a",""]' }))).toEqual(["/a"]);
  });
});

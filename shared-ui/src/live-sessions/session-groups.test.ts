import { describe, expect, it } from "bun:test";
import { groupSessionsByDay, relativeTime, sessionStatusLabel } from "./session-groups";
import type { LiveSession } from "./types";

const NOW = new Date(2026, 9, 27, 15, 0, 0);
const session = (id: string, started: Date): LiveSession => ({
  id, owner_user_id: "u", owner_name: "Maya", title: id, folder_name: "app", host_name: null, status: "live",
  started_at: started.toISOString(), ended_at: null, last_event_at: null, last_seq: 0,
});

describe("groupSessionsByDay", () => {
  it("groups by local day, newest first, and leaves out empty groups", () => {
    const groups = groupSessionsByDay(
      [
        session("old", new Date(2026, 9, 20, 9)),
        session("morning", new Date(2026, 9, 27, 9)),
        session("late-yesterday", new Date(2026, 9, 26, 23, 30)),
        session("noon", new Date(2026, 9, 27, 12)),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ["Today", ["noon", "morning"]],
      ["Yesterday", ["late-yesterday"]],
      ["Earlier", ["old"]],
    ]);
    expect(groupSessionsByDay([session("a", new Date(2026, 9, 27, 1))], NOW).map((g) => g.label)).toEqual(["Today"]);
    expect(groupSessionsByDay([], NOW)).toEqual([]);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  it("uses short units", () => {
    expect(relativeTime("2026-10-27T11:59:40Z", now)).toBe("now");
    expect(relativeTime("2026-10-27T11:55:00Z", now)).toBe("5m");
    expect(relativeTime("2026-10-27T09:00:00Z", now)).toBe("3h");
    expect(relativeTime("2026-10-25T12:00:00Z", now)).toBe("2d");
  });
});

describe("sessionStatusLabel", () => {
  it("spells out the status in words", () => {
    expect(sessionStatusLabel("host_offline")).toBe("Host offline");
  });
});

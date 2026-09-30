import { describe, expect, test } from "bun:test";
import type { TeamSessionRepo } from "../types";
import { codingSessionsStatus, formatRelativeTime, repoMeta, summarizeContributors } from "./session-repos";

const NOW = new Date("2026-09-30T12:00:00.000Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function repo(overrides: Partial<TeamSessionRepo> = {}): TeamSessionRepo {
  return { id: "p1", label: "api", created_at: ago(1e9), created_by: null, last_upload_at: null, session_count: 0, contributors: [], ...overrides };
}

describe("formatRelativeTime", () => {
  test("picks the largest fitting unit", () => {
    expect(formatRelativeTime(ago(10_000), NOW)).toBe("just now");
    expect(formatRelativeTime(ago(5 * 60_000), NOW)).toBe("5m ago");
    expect(formatRelativeTime(ago(2 * 3_600_000), NOW)).toBe("2h ago");
    expect(formatRelativeTime(ago(3 * 86_400_000), NOW)).toBe("3d ago");
  });
});

describe("summarizeContributors", () => {
  test("puts the caller first and counts the rest", () => {
    const people = [
      { display: "Kai", is_me: false, verified: true },
      { display: "Lee", is_me: false, verified: false },
      { display: "Ana", is_me: true, verified: true },
      { display: "Sam", is_me: false, verified: true },
    ];
    expect(summarizeContributors(people)).toBe("You, Kai +2");
    expect(summarizeContributors(people.slice(0, 2))).toBe("Kai, Lee");
    expect(summarizeContributors([])).toBe("");
  });
});

describe("repoMeta", () => {
  test("shows people and last session once there are uploads", () => {
    const r = repo({ last_upload_at: ago(2 * 3_600_000), contributors: [{ display: "Kai", is_me: false, verified: true }] });
    expect(repoMeta(r, NOW)).toBe("Kai · last session 2h ago");
  });

  test("shows who enabled a repo that has no sessions yet", () => {
    expect(repoMeta(repo({ created_by: { user_id: "u", display: "Kai", is_me: false } }), NOW)).toBe("No sessions yet · enabled by Kai");
    expect(repoMeta(repo({ created_by: { user_id: "u", display: "Ana", is_me: true } }), NOW)).toBe("No sessions yet · enabled by you");
    expect(repoMeta(repo(), NOW)).toBe("No sessions yet");
  });
});

describe("codingSessionsStatus", () => {
  test("is disconnected when the workspace switch is off", () => {
    expect(codingSessionsStatus(false, { status: "ready", repos: [repo()] })).toEqual({ state: "disconnected" });
  });

  test("shows a repo count once repos load", () => {
    expect(codingSessionsStatus(true, { status: "loading", repos: [] })).toEqual({ state: "connected", detail: "On" });
    expect(codingSessionsStatus(true, { status: "ready", repos: [] }).detail).toBe("On, no repos yet");
    expect(codingSessionsStatus(true, { status: "ready", repos: [repo()] }).detail).toBe("1 repo capturing");
    expect(codingSessionsStatus(true, { status: "ready", repos: [repo(), repo({ id: "p2" })] }).detail).toBe("2 repos capturing");
  });
});

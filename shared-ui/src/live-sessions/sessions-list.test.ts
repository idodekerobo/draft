import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { keepNewerActivity, liveSessionsQueryKey, sessionTitle, syncSessionIntoLists } from "./sessions-list";
import type { LiveSession } from "./types";

describe("sessionTitle", () => {
  it("drops the author tag of a Draft message", () => {
    expect(sessionTitle({ title: "[idode@example.com via Draft] hello", folder_name: "app" })).toBe("hello");
  });

  it("falls back to the folder when there is no title", () => {
    expect(sessionTitle({ title: null, folder_name: "app" })).toBe("New session in app");
    expect(sessionTitle({ title: "[A via Draft] ", folder_name: null })).toBe("New session in a folder");
  });
});

const row = (id: string, last_event_at: string | null): LiveSession => ({
  id, owner_user_id: "u1", owner_name: "Maya", title: "t", folder_name: "f", host_name: null, status: "live",
  started_at: "2026-10-27T00:00:00Z", ended_at: null, last_event_at, last_seq: 0,
});

describe("syncSessionIntoLists", () => {
  const key = liveSessionsQueryKey("w1");
  const setup = () => {
    const client = new QueryClient();
    client.setQueryData(key, { enabled: true, sessions: [row("a", "2026-10-27T10:00:00Z")] });
    return client;
  };
  const activity = (client: QueryClient) => client.getQueryData<{ sessions: LiveSession[] }>(key)!.sessions[0]!.last_event_at;

  it("takes a newer row", () => {
    const client = setup();
    syncSessionIntoLists(client, row("a", "2026-10-27T11:00:00Z"));
    expect(activity(client)).toBe("2026-10-27T11:00:00Z");
  });

  it("does not let an older server row undo a newer guess", () => {
    const client = setup();
    syncSessionIntoLists(client, row("a", "2026-10-27T11:00:00Z"));
    syncSessionIntoLists(client, row("a", "2026-10-27T10:00:00Z"));
    expect(activity(client)).toBe("2026-10-27T11:00:00Z");
  });

  it("goes back to the old time when forced", () => {
    const client = setup();
    syncSessionIntoLists(client, row("a", "2026-10-27T11:00:00Z"));
    syncSessionIntoLists(client, row("a", "2026-10-27T10:00:00Z"), true);
    expect(activity(client)).toBe("2026-10-27T10:00:00Z");
  });
});

describe("keepNewerActivity", () => {
  it("keeps a newer cached time over an older server time, and takes the server time once it passes", () => {
    const previous = { enabled: true, sessions: [row("a", "2026-10-27T11:00:00Z")] };
    expect(keepNewerActivity(previous, { enabled: true, sessions: [row("a", "2026-10-27T10:00:00Z")] }).sessions[0]!.last_event_at).toBe("2026-10-27T11:00:00Z");
    expect(keepNewerActivity(previous, { enabled: true, sessions: [row("a", "2026-10-27T12:00:00Z")] }).sessions[0]!.last_event_at).toBe("2026-10-27T12:00:00Z");
  });
});

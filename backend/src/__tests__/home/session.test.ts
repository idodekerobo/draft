import { describe, expect, it } from "bun:test";
import { ensureHomeSession } from "../../home/session";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "33333333-3333-4333-8333-333333333333";
const MATE = "44444444-4444-4444-8444-444444444444";

const db = () => fakeDb({ sessions: [] }, { uuidTables: ["sessions"] });

describe("a person's Home session", () => {
  it("is made on first use as a backend session on the pi adapter, owned by the person", async () => {
    const d = db();
    const session = await ensureHomeSession(fakeClient(d), { workspaceId: WS, ownerUserId: OWNER });
    expect(session).toMatchObject({ workspace_id: WS, owner_user_id: OWNER, is_home: true, execution_target: "backend", adapter_id: "pi-durable-sdk", harness: "pi", session_type: "interactive" });
    expect(String(session.host_id)).toStartWith("backend:");
    expect(d.tables.sessions).toHaveLength(1);
  });

  it("returns the same session the next time", async () => {
    const d = db();
    const first = await ensureHomeSession(fakeClient(d), { workspaceId: WS, ownerUserId: OWNER });
    const second = await ensureHomeSession(fakeClient(d), { workspaceId: WS, ownerUserId: OWNER });
    expect(second.id).toBe(first.id);
    expect(d.tables.sessions).toHaveLength(1);
  });

  it("gives each person their own", async () => {
    const d = db();
    const mine = await ensureHomeSession(fakeClient(d), { workspaceId: WS, ownerUserId: OWNER });
    const theirs = await ensureHomeSession(fakeClient(d), { workspaceId: WS, ownerUserId: MATE });
    expect(theirs.id).not.toBe(mine.id);
  });
});

import { describe, expect, it } from "bun:test";
import { PresenceHub } from "./presence-hub";

const viewer = { id: "me", name: "Maya" };

function setup() {
  let time = 1_000;
  const joins: string[] = [];
  const leaves: string[] = [];
  const pushes = new Map<string, (names: string[]) => void>();
  const hub = new PresenceHub((sessionId, _viewer, onNames) => {
    joins.push(sessionId);
    pushes.set(sessionId, onNames);
    return () => void leaves.push(sessionId);
  }, () => time);
  return { hub, joins, leaves, pushes, advance: (ms: number) => void (time += ms) };
}

describe("PresenceHub", () => {
  it("joins once per session and returns the latest names", () => {
    const { hub, joins, pushes } = setup();
    expect(hub.poll("s1", viewer)).toEqual([]);
    pushes.get("s1")!(["Priya"]);
    expect(hub.poll("s1", viewer)).toEqual(["Priya"]);
    expect(joins).toEqual(["s1"]);
  });

  it("keeps a session while it is polled and leaves it after 20 s of silence", () => {
    const { hub, leaves, advance } = setup();
    hub.poll("s1", viewer);
    advance(15_000);
    hub.poll("s1", viewer);
    advance(15_000);
    hub.sweep();
    expect(leaves).toEqual([]);
    advance(6_000);
    hub.sweep();
    expect(leaves).toEqual(["s1"]);
    expect(hub.size()).toBe(0);
  });

  it("joins again when a left session is opened later", () => {
    const { hub, joins, advance } = setup();
    hub.poll("s1", viewer);
    advance(30_000);
    hub.sweep();
    hub.poll("s1", viewer);
    expect(joins).toEqual(["s1", "s1"]);
    hub.sweep();
  });
});

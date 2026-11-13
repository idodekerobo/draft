import { describe, expect, it } from "bun:test";
import { SessionTopics } from "./session-topics";

function setup() {
  const joined: string[] = [];
  const left: string[] = [];
  const listeners = new Map<string, (event: string) => void>();
  const signals: string[] = [];
  const topics = new SessionTopics(
    (topic, listener) => {
      joined.push(topic);
      listeners.set(topic, listener);
      return () => void left.push(topic);
    },
    "s1",
    (event) => void signals.push(event),
  );
  return { topics, joined, left, listeners, signals };
}

describe("SessionTopics", () => {
  it("joins nothing until the server has accepted the session", () => {
    const t = setup();
    expect(t.joined).toEqual([]);
    t.topics.open();
    expect(t.joined).toEqual(["signals:session:s1", "live:session:s1"]);
  });

  it("joins once, however often it is opened", () => {
    const t = setup();
    t.topics.open();
    t.topics.open();
    expect(t.joined).toHaveLength(2);
  });

  it("passes signals of the session topic on", () => {
    const t = setup();
    t.topics.open();
    t.listeners.get("signals:session:s1")!("inputs");
    expect(t.signals).toEqual(["inputs"]);
  });

  it("leaves both topics on close, and a late answer does not join again", () => {
    const t = setup();
    t.topics.open();
    t.topics.close();
    expect(t.left).toEqual(["signals:session:s1", "live:session:s1"]);
    t.topics.open();
    expect(t.joined).toHaveLength(2);
  });

  it("never joins for a session that was closed before the server answered", () => {
    const t = setup();
    t.topics.close();
    t.topics.open();
    expect(t.joined).toEqual([]);
  });
});

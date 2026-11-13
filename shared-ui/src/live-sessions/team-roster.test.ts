import { describe, expect, it } from "bun:test";
import { teamRoster } from "./team-roster";
import type { LiveSessionEvent, LiveSessionEventKind, LiveSessionEventPayload } from "./types";

let seq = 0;
const event = (kind: LiveSessionEventKind, payload: LiveSessionEventPayload): LiveSessionEvent => ({ seq: ++seq, source_id: `s${seq}`, kind, payload, created_at: "2026-11-13T05:00:00.000Z" });

const spawn = (name: string, id: string, extra: Record<string, unknown> = {}) => [
  event("tool_use", { tool_use_id: `t-${name}`, name: "Agent", input: { name, description: `Does ${name}`, model: "haiku", prompt: "go", ...extra } }),
  event("tool_result", { tool_use_id: `t-${name}`, content: `Spawned successfully.\nagent_id: ${id}\nname: ${name}` }),
];
const idle = (from: string) => event("session_note", { text: `Message from ${from}`, agent_message: { from, type: "idle", text: "Done" } });
const toAgent = (agentId: string, from: string) => event("session_note", { text: `Message from ${from}`, agent_id: agentId, agent_message: { from, type: "message", text: "More work" } });

describe("teamRoster", () => {
  it("lists named agents in spawn order, working until they report", () => {
    const events = [...spawn("a", "aa-1"), ...spawn("b", "bb-2")];
    expect(teamRoster(events)).toMatchObject([
      { name: "a", state: "working", description: "Does a", model: "haiku" },
      { name: "b", state: "working" },
    ]);
    expect(teamRoster(events)[0]!.hostSeq).toBe(events[0]!.seq);
  });

  it("ignores a sub-agent with no name and a call made by an agent", () => {
    const plain = event("tool_use", { tool_use_id: "p", name: "Agent", input: { description: "look", prompt: "x" } });
    const nested = event("tool_use", { tool_use_id: "n", name: "Agent", agent_id: "aa-1", input: { name: "inner" } });
    expect(teamRoster([plain, nested])).toEqual([]);
  });

  it("marks an agent idle when it reports, and working again when it gets a message", () => {
    const events = [...spawn("a", "aa-1"), ...spawn("b", "bb-2"), idle("a"), idle("b")];
    expect(teamRoster(events).map((m) => m.state)).toEqual(["idle", "idle"]);
    expect(teamRoster([...events, toAgent("aa-1", "team-lead")]).map((m) => m.state)).toEqual(["working", "idle"]);
  });

  it("does not wake an agent for its own message or for an unknown agent", () => {
    const events = [...spawn("a", "aa-1"), idle("a"), toAgent("aa-1", "a"), toAgent("zz-9", "team-lead"), idle("ghost")];
    expect(teamRoster(events).map((m) => m.state)).toEqual(["idle"]);
  });

  it("lets a new agent with the same name replace the old one", () => {
    const events = [...spawn("a", "aa-1"), idle("a"), ...spawn("a", "aa-2")];
    expect(teamRoster(events)).toMatchObject([{ name: "a", state: "working" }]);
  });
});

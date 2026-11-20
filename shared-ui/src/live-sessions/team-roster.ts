import type { LiveSessionEvent } from "./types";

export interface TeamMember {
  key?: string;
  name: string;
  named?: boolean;
  /** Idle once it reports back. Working again when it gets a new message. */
  state: "working" | "idle";
  /** The spawn call's seq. It is the row in the stream that holds the agent's work. */
  hostSeq: number;
  description: string | null;
  model: string | null;
}

export function agentStripMembers(agents: import("./types").SessionAgentSummary[]): TeamMember[] {
  return agents.filter((agent) => agent.name || (agent.async && agent.state === "working")).map((agent) => ({
    key: agent.key, name: agent.name || agent.description || "Agent", named: !!agent.name,
    state: agent.state, hostSeq: agent.hostSeq ?? agent.firstSeq, description: agent.description, model: agent.model,
  }));
}

const SPAWN_TOOLS = new Set(["Agent", "Task"]);
const SPAWNED_AGENT_ID = /agent_?[iI]d:\s*([A-Za-z0-9_-]+)/;

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/** Named team members and working async sub-agents, in spawn order. */
export function teamRoster(events: LiveSessionEvent[]): TeamMember[] {
  const members = new Map<string, TeamMember & { agentId: string | null; async?: boolean }>();
  const byCall = new Map<string, string>();
  const pending = new Map<string, { seq: number; input: Record<string, unknown> }>();

  for (const { seq, kind, payload } of events) {
    if (kind === "tool_use" && !payload.agent_id && payload.name && SPAWN_TOOLS.has(payload.name)) {
      const input = (payload.input ?? {}) as Record<string, unknown>;
      const name = text(input.name);
      if (payload.tool_use_id) pending.set(payload.tool_use_id, { seq, input });
      if (!name) continue;
      // A new agent with a name in use replaces the old one.
      members.delete(name);
      members.set(name, { name, state: "working", hostSeq: seq, description: text(input.description), model: text(input.model), agentId: null });
      if (payload.tool_use_id) byCall.set(payload.tool_use_id, name);
    } else if (kind === "tool_result" && payload.tool_use_id && payload.agent_result?.async && pending.has(payload.tool_use_id) && !byCall.has(payload.tool_use_id)) {
      const spawn = pending.get(payload.tool_use_id)!;
      const id = payload.agent_result.id;
      members.set(id, { key: `agent:${id}`, name: text(spawn.input.description) ?? text(spawn.input.subagent_type) ?? "Agent", named: false, async: true, agentId: id, state: payload.is_error ? "idle" : "working", hostSeq: spawn.seq, description: text(spawn.input.description), model: payload.agent_result.model });
    } else if (kind === "tool_result" && payload.tool_use_id && byCall.has(payload.tool_use_id)) {
      const member = members.get(byCall.get(payload.tool_use_id)!);
      const id = payload.agent_result?.id ?? SPAWNED_AGENT_ID.exec(payload.content ?? "")?.[1];
      if (member && id) member.agentId = id;
    } else if (kind === "session_note" && payload.agent_message) {
      const message = payload.agent_message;
      if (payload.agent_id) {
        // A message into the agent's own transcript is new work for it, unless the agent wrote it.
        const member = [...members.values()].find((m) => m.agentId === payload.agent_id);
        if (member && message.from !== member.name) member.state = "working";
      } else if (message.type === "idle") {
        const member = members.get(message.from);
        if (member) member.state = "idle";
      }
    }
    if (payload.agent_lifecycle) {
      const member = [...members.values()].find((m) => m.agentId === payload.agent_lifecycle!.id);
      if (member) member.state = payload.agent_lifecycle.state;
    }
  }
  return [...members.values()].filter((m) => !m.async || m.state === "working").map(({ agentId: _agentId, async: _async, ...member }) => member);
}

import type { LiveSessionEvent } from "./types";

export interface TeamMember {
  name: string;
  /** Idle once it reports back. Working again when it gets a new message. */
  state: "working" | "idle";
  /** The spawn call's seq. It is the row in the stream that holds the agent's work. */
  hostSeq: number;
  description: string | null;
  model: string | null;
}

const SPAWN_TOOLS = new Set(["Agent", "Task"]);
const SPAWNED_AGENT_ID = /agent_?[iI]d:\s*([A-Za-z0-9_-]+)/;

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/**
 * The agents a session started as team members, in spawn order. A call with no `name` starts a plain
 * sub-agent, which is not a team member.
 */
export function teamRoster(events: LiveSessionEvent[]): TeamMember[] {
  const members = new Map<string, TeamMember & { agentId: string | null }>();
  const byCall = new Map<string, string>();

  for (const { seq, kind, payload } of events) {
    if (kind === "tool_use" && !payload.agent_id && payload.name && SPAWN_TOOLS.has(payload.name)) {
      const input = (payload.input ?? {}) as Record<string, unknown>;
      const name = text(input.name);
      if (!name) continue;
      // A new agent with a name in use replaces the old one.
      members.delete(name);
      members.set(name, { name, state: "working", hostSeq: seq, description: text(input.description), model: text(input.model), agentId: null });
      if (payload.tool_use_id) byCall.set(payload.tool_use_id, name);
    } else if (kind === "tool_result" && payload.tool_use_id && byCall.has(payload.tool_use_id)) {
      const member = members.get(byCall.get(payload.tool_use_id)!);
      const id = SPAWNED_AGENT_ID.exec(payload.content ?? "")?.[1];
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
  }
  return [...members.values()].map(({ agentId: _agentId, ...member }) => member);
}

import type { TeamMember } from "./team-roster";

/** One chip per agent in the session's team, with what it is doing. A chip jumps to that agent's work. */
export function TeamStrip({ members, onShow }: { members: TeamMember[]; onShow: (member: TeamMember) => void }) {
  if (members.length === 0) return null;
  return (
    <ul className="ui-team" aria-label="Agents in this session">
      {members.map((member) => (
        <li key={member.name}>
          <button
            type="button"
            className="ui-team__chip"
            title={[member.description, member.model].filter(Boolean).join(" · ") || undefined}
            onClick={() => onShow(member)}
          >
            <span className={`ui-dot${member.state === "working" ? " ui-dot--pending" : ""}`} aria-hidden="true" />
            <span className="ui-team__name">@{member.name}</span>
            <span className="ui-muted">{member.state}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

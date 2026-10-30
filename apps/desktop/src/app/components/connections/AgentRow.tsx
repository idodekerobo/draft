import type { ReactNode } from "react";

export interface AgentLine {
  /** Where the agent runs for this line, for example "Sessions on this computer". */
  label: string;
  description: string;
  /** Extra text or controls under the description. */
  extra?: ReactNode;
  actions?: ReactNode;
  error?: string | null;
}

/** One row for an agent, with a line for each place it runs and the actions that belong to that place. */
export function AgentRow({ name, lines }: { name: string; lines: AgentLine[] }) {
  return (
    <div className="settings__row settings__row--stacked">
      <span className="settings__row-label">{name}</span>
      <div className="settings__agent-lines">
        {lines.map((line) => (
          <div key={line.label} className="settings__agent-line">
            <div className="settings__row-content">
              <span className="settings__agent-line-label">{line.label}</span>
              <span className="settings__row-desc">{line.description}</span>
              {line.extra}
              {line.error && <span className="ui-error" role="alert">{line.error}</span>}
            </div>
            {line.actions && <div className="settings__row-control-stack">{line.actions}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

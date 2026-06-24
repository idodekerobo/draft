import { useEffect, useState } from "react";
import type { ScannedSkillEntry, ScanDirError } from "../../../../rpc/schema";
import { rpc } from "../../../rpc";
import { AGENT_LABELS, formatTokens, groupByAgent, skillKey, type Agent } from "../../shared/skills";

interface SkillSyncSectionProps {
  onError: (message: string) => void;
}

function SkillRow({ skill, onToggle, toggling }: {
  skill: ScannedSkillEntry;
  onToggle: (skill: ScannedSkillEntry) => void;
  toggling: boolean;
}) {
  const synced = skill.synced ?? false;

  return (
    <div className="app-row">
      <div className="app-row__left">
        <span className={`app-row__status-dot${synced ? " app-row__status-dot--on" : ""}`} />
        <div className="app-row__text">
          <span className="app-row__name">{skill.name}</span>
          <span className="app-row__meta">
            {AGENT_LABELS[skill.agent]} · ~{formatTokens(skill.tokenCount)} tokens
          </span>
          {skill.description && (
            <span className="app-row__hint">{skill.description}</span>
          )}
        </div>
      </div>

      <button
        className={synced ? "app-row__disconnect" : "app-row__connect"}
        onClick={() => onToggle(skill)}
        disabled={toggling}
      >
        {toggling ? (synced ? "Removing…" : "Importing…") : synced ? "Remove" : "Import"}
      </button>
    </div>
  );
}

function AgentGroup({ agent, skills, onToggle, togglingKey }: {
  agent: Agent;
  skills: ScannedSkillEntry[];
  onToggle: (skill: ScannedSkillEntry) => void;
  togglingKey: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  if (skills.length === 0) return null;

  const syncedCount = skills.filter((s) => s.synced).length;

  return (
    <div className="skill-agent-group">
      <button
        className="skill-agent-group__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="skill-agent-group__toggle">{expanded ? "▼" : "▶"}</span>
        <span className="skill-agent-group__label">{AGENT_LABELS[agent]}</span>
        <span className="skill-agent-group__count">{syncedCount}/{skills.length} synced</span>
      </button>
      {expanded && skills.map((skill) => (
        <SkillRow
          key={skillKey(skill)}
          skill={skill}
          onToggle={onToggle}
          toggling={togglingKey === skillKey(skill)}
        />
      ))}
    </div>
  );
}

export function SkillSyncSection({ onError }: SkillSyncSectionProps) {
  const [skills, setSkills] = useState<ScannedSkillEntry[] | null>(null);
  const [scanErrors, setScanErrors] = useState<ScanDirError[]>([]);
  const [scanning, setScanning] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  async function scan() {
    setScanning(true);
    try {
      const result = await rpc.request.scanSkills();
      setSkills(result.skills);
      setScanErrors(result.scanErrors ?? []);
    } catch {
      onError("Could not scan skill directories.");
      setSkills([]);
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => { void scan(); }, []);

  async function handleToggle(skill: ScannedSkillEntry) {
    const key = skillKey(skill);
    setTogglingKey(key);
    try {
      if (skill.synced) {
        const result = await rpc.request.removeSkills({ skills: [skill] });
        if (!result.ok) {
          onError(result.error ?? "Could not remove skill.");
          return;
        }
      } else {
        const result = await rpc.request.importSkills({ skills: [skill] });
        if (!result.ok) {
          onError(result.error ?? "Could not import skill.");
          return;
        }
      }
      const refreshed = await rpc.request.scanSkills();
      setSkills(refreshed.skills);
      setScanErrors(refreshed.scanErrors ?? []);
    } catch {
      onError("Skill sync failed.");
    } finally {
      setTogglingKey(null);
    }
  }

  const groups = groupByAgent(skills ?? []);
  const hasSkills = (skills ?? []).length > 0;
  const isLoading = skills === null;

  return (
    <section className="settings__section">
      <div className="settings__section-header">
        <h2 className="settings__section-label">Sync Skills</h2>
        <button
          className="app-row__connect settings__section-action"
          onClick={() => void scan()}
          disabled={scanning}
        >
          {scanning ? "Scanning…" : "Rescan"}
        </button>
      </div>
      <div className="settings__rows">
        {isLoading && (
          <div className="app-row">
            <div className="app-row__left">
              <div className="app-row__text">
                <span className="app-row__meta">{scanning ? "Scanning skill directories…" : "Loading…"}</span>
              </div>
            </div>
          </div>
        )}

        {!isLoading && scanErrors.length > 0 && scanErrors.map((err) => (
          <div key={err.dir} className="app-row">
            <div className="app-row__left">
              <div className="app-row__text">
                <span className="app-row__hint" style={{ color: "var(--color-status-yellow)" }}>
                  Could not read {AGENT_LABELS[err.agent]} skills directory
                </span>
              </div>
            </div>
          </div>
        ))}

        {!isLoading && (
          <div className="skill-sync__list">
            {hasSkills && groups.map(({ agent, skills: agentSkills }) => (
              <AgentGroup
                key={agent}
                agent={agent}
                skills={agentSkills}
                onToggle={handleToggle}
                togglingKey={togglingKey}
              />
            ))}

            {!hasSkills && (
              <div className="app-row">
                <div className="app-row__left">
                  <div className="app-row__text">
                    <span className="app-row__name">No third-party skills found</span>
                    <span className="app-row__meta">Install skills in Claude Code or Codex and they'll appear here</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </section>
  );
}

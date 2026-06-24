// ToolSelectionStep.tsx — step 3: choose AI tools + install

import type { InstallableTool, InstallStep } from "../../../../rpc/schema";
import { rpc } from "../../../rpc";
import { TOOL_OPTIONS } from "./constants";

interface ToolSelectionStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  selected: Set<InstallableTool>;
  toggleTool: (id: InstallableTool) => void;
  installing: boolean;
  steps: InstallStep[];
  installError: string | null;
  showContinue: boolean;
  handleInstall: () => void;
  prereqTools: { id: InstallableTool; label: string; url: string }[];
  onSkip: () => void;
}

export function ToolSelectionStep({
  stepNum,
  totalSteps,
  onBack,
  selected,
  toggleTool,
  installing,
  steps,
  installError,
  showContinue,
  handleInstall,
  prereqTools,
  onSkip,
}: ToolSelectionStepProps) {
  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Choose your AI tools</h1>
      <p className="onboarding__desc">
        Select the tools you use. Draft connects to each one in two ways.
      </p>

      <div className="onboarding__section-group">
        <p className="onboarding__section-label">WHAT GETS INJECTED</p>
        <p className="onboarding__section-body">
          Your workspace context is injected at the start of every session. Preview
          exactly what gets sent — content and token count — and control what's
          included in Settings → Session Context.
        </p>
        <p className="onboarding__section-label" style={{ marginTop: 10 }}>WHAT CAN ANALYZE YOUR INPUTS</p>
        <p className="onboarding__section-body">
          Claude Code and Codex routinely check your connected integrations —
          Granola for new meeting notes, Slack for channel activity — and update
          your context automatically.
        </p>
      </div>

      {prereqTools.length > 0 && (
        <div className="onboarding__prereq">
          <span className="onboarding__prereq-label">Prerequisite</span>
          {prereqTools.map((tool) => (
            <div key={tool.id} className="onboarding__prereq-row">
              <span className="onboarding__prereq-tool">{tool.label}</span>
              <button
                className="onboarding__prereq-link"
                onClick={() => rpc.send.openUrl({ url: tool.url })}
              >
                Install ↗
              </button>
            </div>
          ))}
          <span className="onboarding__prereq-note">
            CLI tools only — not the desktop apps. Make sure you're logged in before installing.
          </span>
        </div>
      )}

      <div className="onboarding__tool-list">
        {TOOL_OPTIONS.map((tool) => (
          <button
            key={tool.id}
            className={`onboarding__tool-row${selected.has(tool.id) ? " onboarding__tool-row--selected" : ""}`}
            onClick={() => !installing && toggleTool(tool.id)}
            disabled={installing}
          >
            <span className="onboarding__tool-check">
              {selected.has(tool.id) ? "✓" : ""}
            </span>
            <span className="onboarding__tool-text">
              <span className="onboarding__tool-name">{tool.name}</span>
              <span className="onboarding__tool-desc">{tool.description}</span>
            </span>
          </button>
        ))}
      </div>

      {steps.length > 0 && (
        <div className="onboarding__progress">
          {steps.map((s, i) => (
            <div key={i} className="onboarding__progress-row">
              <span className={`onboarding__progress-icon${s.ok ? " onboarding__progress-icon--ok" : " onboarding__progress-icon--fail"}`}>
                {s.ok ? "✓" : "✕"}
              </span>
              <span className="onboarding__progress-label">{s.label}</span>
              {!s.ok && s.error && (
                <span className="onboarding__progress-error">{s.error}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {installError && (
        <p className="onboarding__error">{installError}</p>
      )}

      <div className="onboarding__actions">
        <button
          className="empty-state__cta onboarding__cta"
          onClick={handleInstall}
          disabled={installing || selected.size === 0}
        >
          {installing ? "Installing…" : "Install"}
        </button>
        {showContinue && (
          <button
            className="onboarding__skip"
            onClick={onSkip}
          >
            Continue anyway
          </button>
        )}
      </div>
    </div>
  );
}

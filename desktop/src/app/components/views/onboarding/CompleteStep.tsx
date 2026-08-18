// CompleteStep.tsx — final consent screen

import { CopyableCmd } from "./shared";

// How-to-use is grouped by client category so new categories (MCP clients,
// etc.) can be appended here later without restructuring the screen.
interface AgentCommand {
  agent: string;
  cmd: string;
}
interface HowToUseStep {
  label: string;
  command?: string;
  agentCommands?: AgentCommand[];
}
interface HowToUseCategory {
  title: string;
  description: string;
  steps: HowToUseStep[];
}

const HOW_TO_USE_CATEGORIES: HowToUseCategory[] = [
  {
    title: "Coding agents",
    description: "Point any terminal coding agent at Draft's company brain — the CLI is how it gets there.",
    steps: [
      {
        label: "1. Sign in — once per machine, works for every project after",
        command: "draft auth login",
      },
      {
        label: "2. Wire in a project — run inside that project's folder; updates its CLAUDE.md/AGENTS.md with Draft + CLI instructions",
        agentCommands: [
          { agent: "Claude Code", cmd: "draft add claude-code" },
          { agent: "Codex", cmd: "draft add codex" },
          { agent: "Cursor", cmd: "draft add cursor" },
          { agent: "OpenClaw", cmd: "draft add openclaw" },
          { agent: "Hermes", cmd: "draft add hermes" },
        ],
      },
    ],
  },
];

interface CompleteStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  handleStart: () => void | Promise<void>;
  consentAnswered: boolean;
  consentSaving: boolean;
  handleConsent: (granted: boolean) => void;
}

export function CompleteStep({
  stepNum,
  totalSteps,
  onBack,
  handleStart,
  consentAnswered,
  consentSaving,
  handleConsent,
}: CompleteStepProps) {
  if (!consentAnswered) {
    return (
      <div className="onboarding__body">
        <div className="onboarding__nav">
          <button className="onboarding__back" onClick={onBack}>← Back</button>
          <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
        </div>
        <h1 className="onboarding__title">Help us improve Draft?</h1>
        <p className="onboarding__desc">Share anonymous usage data so we can see where people get stuck and what’s working.</p>
        <p className="onboarding__hint">We never collect prompts, conversations, context-file contents, file names, or paths.</p>
        <div className="onboarding__actions" style={{ marginTop: 20 }}>
          <button className="empty-state__cta onboarding__cta" onClick={() => void handleConsent(true)} disabled={consentSaving}>Yes, help improve Draft</button>
          <button className="onboarding__skip" onClick={() => void handleConsent(false)} disabled={consentSaving}>No thanks</button>
        </div>
      </div>
    );
  }
  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">You're all set.</h1>
      <p className="onboarding__desc">
        If you started a synthesis run, it's running in the cloud now — check the Context tab
        in a few minutes to see it land. Claude Code will use it from then on, no extra setup needed.
      </p>

      <div className="onboarding__section-group">
        <div className="onboarding__section-label">HOW TO USE DRAFT</div>
        {HOW_TO_USE_CATEGORIES.map((category) => (
          <div key={category.title} className="onboarding__connect-panel">
            <span className="onboarding__panel-label">{category.title}</span>
            <span className="onboarding__panel-help">{category.description}</span>
            {category.steps.map((step) => (
              <div key={step.label} className="onboarding__howto-step">
                <span className="onboarding__input-cmd-label">{step.label}</span>
                {step.command && <CopyableCmd cmd={step.command} />}
                {step.agentCommands && (
                  <div className="onboarding__agent-table">
                    {step.agentCommands.map((row) => (
                      <div key={row.agent} className="onboarding__agent-row">
                        <span className="onboarding__agent-name">{row.agent}</span>
                        <CopyableCmd cmd={row.cmd} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <button
        className="empty-state__cta onboarding__cta"
        style={{ marginTop: 24 }}
        onClick={() => void handleStart()}
      >
        Let's go
      </button>
    </div>
  );
}

// InputsStep.tsx — step 4: connect input sources (Granola, Slack, GitHub)

import { CopyableCmd } from "./shared";

interface InputsStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  connectingGitHub: boolean;
  githubConnected: boolean;
  githubError: string | null;
  handleConnectGitHub: () => void;
  onNext: () => void;
}

export function InputsStep({
  stepNum,
  totalSteps,
  onBack,
  connectingGitHub,
  githubConnected,
  githubError,
  handleConnectGitHub,
  onNext,
}: InputsStepProps) {
  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Connect your input sources</h1>
      <p className="onboarding__desc">
        Draft routinely checks these sources for new content and updates your
        workspace context automatically.
      </p>

      <div className="onboarding__tool-list">
        {/* Granola */}
        <div className="onboarding__input-row">
          <span className="onboarding__tool-text">
            <span className="onboarding__tool-name">Granola</span>
            <span className="onboarding__tool-desc">Meeting notes — routinely checked for new content</span>
            <span className="onboarding__input-cmd-label">Run in Claude Code or Codex:</span>
            <CopyableCmd cmd="/draft-connect granola" />
          </span>
        </div>

        {/* Slack */}
        <div className="onboarding__input-row">
          <span className="onboarding__tool-text">
            <span className="onboarding__tool-name">Slack</span>
            <span className="onboarding__tool-desc">Channel activity — routinely checked for team updates, decisions, and shifts</span>
            <span className="onboarding__input-cmd-label">Run in Claude Code or Codex:</span>
            <CopyableCmd cmd="/draft-connect slack" />
          </span>
        </div>

        {/* GitHub */}
        <div className="onboarding__input-row onboarding__input-row--with-action">
          <span className="onboarding__tool-text">
            <span className="onboarding__tool-name">GitHub</span>
            <span className="onboarding__tool-desc">Your repos and PRs — routinely checked for engineering context</span>
          </span>
          <span className="onboarding__input-action">
            {githubConnected ? (
              <span className="onboarding__input-connected">Connected ✓</span>
            ) : (
              <button
                className="app-row__connect"
                onClick={() => void handleConnectGitHub()}
                disabled={connectingGitHub}
              >
                {connectingGitHub ? "Waiting…" : "Connect"}
              </button>
            )}
          </span>
        </div>
      </div>

      {githubError && <p className="onboarding__error">{githubError}</p>}

      <p className="onboarding__hint">
        You can skip for now and connect these later in Settings → Input Sources.
      </p>

      <button
        className="empty-state__cta onboarding__cta"
        style={{ marginTop: 20 }}
        onClick={onNext}
      >
        Continue
      </button>
    </div>
  );
}

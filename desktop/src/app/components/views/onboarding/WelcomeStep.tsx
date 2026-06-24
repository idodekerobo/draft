// WelcomeStep.tsx — step 1: what Draft is + three-component architecture

interface WelcomeStepProps {
  stepNum: number;
  totalSteps: number;
  onNext: () => void;
}

export function WelcomeStep({ stepNum, totalSteps, onNext }: WelcomeStepProps) {
  return (
    <div className="onboarding__body">
      <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      <h1 className="onboarding__title">Your workspace. Your team. Always in sync.</h1>
      <p className="onboarding__desc">
        Draft gives you a persistent workspace — product context, priorities,
        and decisions that load automatically across every agent session. Use
        it solo, or share it with your whole team.
      </p>

      <div className="onboarding__arch">
        <div className="onboarding__arch-row">
          <span className="onboarding__arch-label">Workspace</span>
          <span className="onboarding__arch-desc">Your product context, priorities, and decisions in one place</span>
        </div>
        <div className="onboarding__arch-row">
          <span className="onboarding__arch-label">Sync</span>
          <span className="onboarding__arch-desc">Publish to a repo — everyone's sessions start from the same content</span>
        </div>
        <div className="onboarding__arch-row">
          <span className="onboarding__arch-label">Capture</span>
          <span className="onboarding__arch-desc">Meetings, Slack, and GitHub activity synthesized into proposals</span>
        </div>
        <div className="onboarding__arch-row">
          <span className="onboarding__arch-label">Review</span>
          <span className="onboarding__arch-desc">A proposals inbox — you control what gets added to your workspace</span>
        </div>
      </div>

      <p className="onboarding__hint">
        Works with Claude Code, Codex, and Cursor. Install once — your full
        team context loads at the start of every session, for every agent,
        every teammate.
      </p>

      <button
        className="empty-state__cta onboarding__cta"
        style={{ marginTop: 20 }}
        onClick={onNext}
      >
        Get started
      </button>
    </div>
  );
}

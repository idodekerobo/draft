// CollabStep.tsx — step 5: team collaboration awareness

interface CollabStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

export function CollabStep({ stepNum, totalSteps, onBack, onNext }: CollabStepProps) {
  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Working with a team?</h1>
      <p className="onboarding__desc">
        Draft can share your context layer across your whole team. Everyone's
        sessions start with the same shared product knowledge, kept fresh as
        things change.
      </p>

      <div className="onboarding__collab-section">
        <p className="onboarding__section-label">SET UP IN CLAUDE CODE OR CODEX</p>
        <p className="onboarding__section-body">
          Run{" "}
          <code className="onboarding__code">/draft-setup-collab</code>
          {" "}— it walks you through connecting a private GitHub repo as a
          shared context layer in about 5 minutes. One person sets it up;
          teammates connect with a URL.
        </p>
        <p className="onboarding__section-body" style={{ marginTop: 6, color: "var(--color-text-tertiary)", fontSize: "var(--font-size-micro)" }}>
          Note: this uses a dedicated GitHub repo as a sync layer — separate from
          connecting your GitHub account as an input source in step 4.
        </p>
      </div>

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

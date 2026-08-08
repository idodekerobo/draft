// CompleteStep.tsx — final consent + daemon start screen

interface CompleteStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  isStarting: boolean;
  handleStart: () => void;
  consentAnswered: boolean;
  consentSaving: boolean;
  handleConsent: (granted: boolean) => void;
}

export function CompleteStep({
  stepNum,
  totalSteps,
  onBack,
  isStarting,
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
      {/* TODO: this screen previously pointed at /draft-setup, the `draft`
          CLI, and the local background daemon, local-model concepts
          that don't apply now Simplified to just close out onboarding until those are rebuilt. */}
      <h1 className="onboarding__title">You're all set.</h1>
      <p className="onboarding__desc">
        If you started a synthesis run, your initial context will load automatically once it
        finishes. Claude Code will use it from then on — no extra setup needed.
      </p>

      <button
        className="empty-state__cta onboarding__cta"
        style={{ marginTop: 24 }}
        onClick={handleStart}
        disabled={isStarting}
      >
        {isStarting ? "Starting…" : "Let's go"}
      </button>
    </div>
  );
}

// ConsentStep.tsx — step 6: analytics opt-in/out

interface ConsentStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  consentSaving: boolean;
  handleConsent: (granted: boolean) => void;
}

export function ConsentStep({
  stepNum,
  totalSteps,
  onBack,
  consentSaving,
  handleConsent,
}: ConsentStepProps) {
  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Help us improve Draft?</h1>
      <p className="onboarding__desc">
        Share anonymous usage data so we can see where people get stuck and
        what's working.
      </p>

      <div className="onboarding__consent-details">
        <p className="onboarding__section-label" style={{ marginBottom: 8 }}>WE NEVER COLLECT</p>
        <div className="onboarding__consent-row">
          <span className="onboarding__consent-check--no">✗</span>
          <span>Prompts or conversations</span>
        </div>
        <div className="onboarding__consent-row">
          <span className="onboarding__consent-check--no">✗</span>
          <span>Content of your context files</span>
        </div>
        <div className="onboarding__consent-row">
          <span className="onboarding__consent-check--no">✗</span>
          <span>File names or paths</span>
        </div>
      </div>

      <p className="onboarding__hint" style={{ marginTop: 12 }}>
        We collect navigation patterns and error codes only. Data is aggregated
        and never tied to your identity.
      </p>

      <div className="onboarding__actions" style={{ marginTop: 20 }}>
        <button
          className="empty-state__cta onboarding__cta"
          onClick={() => void handleConsent(true)}
          disabled={consentSaving}
        >
          Yes, help improve Draft
        </button>
        <button
          className="onboarding__skip"
          onClick={() => void handleConsent(false)}
          disabled={consentSaving}
        >
          No thanks
        </button>
      </div>
    </div>
  );
}

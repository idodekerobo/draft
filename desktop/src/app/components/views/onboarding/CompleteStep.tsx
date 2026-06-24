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
      <h1 className="onboarding__title">One last thing — then you're running.</h1>

      <div className="onboarding__education">
        <div className="onboarding__education-text">
          <strong>Context setup</strong>
          <span>
            If you skipped setup, open Claude Code or Codex and run{" "}
            <code className="onboarding__code">/draft-setup</code>
            {" "}any time. Otherwise, you can refine the context Draft just created as your product evolves.
          </span>
        </div>
      </div>

      <div className="onboarding__education" style={{ marginTop: 10 }}>
        <div className="onboarding__education-text">
          <strong>Draft is also a CLI</strong>
          <span>
            Run{" "}
            <code className="onboarding__code">draft --help</code>
            {" "}in your terminal. Every feature in this app is also available
            as commands — manage workspaces, switch profiles, check status.
          </span>
        </div>
      </div>

      <div className="onboarding__education" style={{ marginTop: 10 }}>
        <div className="onboarding__education-text">
          <strong>Runs in the background</strong>
          <span>
            Draft runs while your Mac is on — the desktop app doesn't need to
            stay open. Close it anytime and Draft keeps capturing context. You'll
            find Draft in your menu bar, and you can start, stop, and control it
            from there or from your terminal.
          </span>
        </div>
      </div>

      <button
        className="empty-state__cta onboarding__cta"
        style={{ marginTop: 24 }}
        onClick={handleStart}
        disabled={isStarting}
      >
        {isStarting ? "Starting…" : "Start Draft"}
      </button>
    </div>
  );
}

// CompleteStep.tsx — step 7: /draft-setup CTA + tray/background note + Start Draft

interface CompleteStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  isStarting: boolean;
  handleStart: () => void;
}

export function CompleteStep({
  stepNum,
  totalSteps,
  onBack,
  isStarting,
  handleStart,
}: CompleteStepProps) {
  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">One last thing — then you're running.</h1>

      <div className="onboarding__education">
        <div className="onboarding__education-text">
          <strong>Load your product context</strong>
          <span>
            Open Claude Code or Codex and run{" "}
            <code className="onboarding__code">/draft-setup</code>
            {" "}— a 3–5 minute interview. After that, every session starts knowing
            your product, team, and current priorities. You'll never have to
            re-explain your product to an agent again.
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

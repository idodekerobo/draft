// PathChoiceStep.tsx — fork right after Welcome: solo setup vs. joining a team

interface PathChoiceStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onChoose: (path: "join" | "solo") => void;
  /** False when this build has no GitHub OAuth client id baked in, or the kill switch is off. */
  joinAvailable: boolean;
}

export function PathChoiceStep({ stepNum, totalSteps, onBack, onChoose, joinAvailable }: PathChoiceStepProps) {
  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">How are you starting?</h1>
      <p className="onboarding__desc">
        You can set up your own workspace, or join one a teammate already
        created.
      </p>

      <div className="onboarding__tool-list">
        <button className="onboarding__tool-row" onClick={() => onChoose("solo")}>
          <span className="onboarding__tool-check" />
          <span className="onboarding__tool-text">
            <span className="onboarding__tool-name">I'm setting up on my own</span>
            <span className="onboarding__tool-desc">Create a new workspace and populate its context yourself</span>
          </span>
        </button>
        <button
          className="onboarding__tool-row"
          onClick={() => joinAvailable && onChoose("join")}
          disabled={!joinAvailable}
        >
          <span className="onboarding__tool-check" />
          <span className="onboarding__tool-text">
            <span className="onboarding__tool-name">I'm joining a team</span>
            <span className="onboarding__tool-desc">
              {joinAvailable
                ? "Connect to a teammate's shared context with a repo URL and GitHub sign-in"
                : "GitHub join isn't available in this build"}
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}

import { HeadlessSetupPanel } from "./shared";

interface HeadlessSetupStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

export function HeadlessSetupStep({ stepNum, totalSteps, onBack, onNext }: HeadlessSetupStepProps) {
  return (
    <div className="onboarding__body onboarding__body--wide">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Set up your context</h1>
      <p className="onboarding__desc">Draft is bootstrapping your workspace context. This is a one time analysis that may take several minutes depeneding on how many files are in the project folder.</p>
      <HeadlessSetupPanel onComplete={onNext} onSkip={onNext} />
    </div>
  );
}

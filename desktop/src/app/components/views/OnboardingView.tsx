import { OnboardingOrchestrator } from "./onboarding/OnboardingOrchestrator";

interface OnboardingViewProps {
  onComplete: () => void;
}

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  return <OnboardingOrchestrator onComplete={onComplete} />;
}

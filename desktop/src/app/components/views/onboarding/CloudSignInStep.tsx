import { useUserIdentity } from "../../../identity/UserIdentityContext";
import { useCloudSignIn } from "../../../hooks/useCloudSignIn";

interface CloudSignInStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

export function CloudSignInStep({ stepNum, totalSteps, onBack, onNext }: CloudSignInStepProps) {
  const { cloudSignIn, cloudSignInError, handleCloudSignIn } = useCloudSignIn();
  const { workspaceId, signedIn, hydrated } = useUserIdentity();

  // TODO: Add a no-workspace team-creation/invite flow; Continue currently lets
  // signed-in users proceed without a resolved workspace.
  const complete = cloudSignIn === "complete" && hydrated && signedIn;

  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Connect Draft Cloud</h1>
      <p className="onboarding__desc">Sign in once to connect this desktop to your shared workspace. Your source connections and context stay available across devices.</p>
      <div className="onboarding__cloud-sign-in-panel">
        <span className="onboarding__cloud-sign-in-status" data-phase={cloudSignIn}>
          {cloudSignIn === "awaiting_approval" ? "Finish signing in in your browser" : cloudSignIn === "complete" && !hydrated ? "Finishing sign-in…" : complete ? (workspaceId ? "Signed in — loading your workspace" : "Signed in — no team yet") : cloudSignIn === "error" ? "Sign-in needs attention" : "Not connected"}
        </span>
        {complete && !workspaceId && (
          <span className="onboarding__hint">
            You're signed in, but not on a team yet. Ask your team admin for an invite link, or continue for now — you can join a team later.
          </span>
        )}
        {cloudSignInError && <span className="onboarding__error">{cloudSignInError}</span>}
        {complete ? (
          <button className="empty-state__cta onboarding__cta" onClick={onNext}>Continue</button>
        ) : (
          <button className="empty-state__cta onboarding__cta" onClick={() => void handleCloudSignIn()} disabled={cloudSignIn === "awaiting_approval"}>
            {cloudSignIn === "awaiting_approval" ? "Waiting…" : "Sign in"}
          </button>
        )}
      </div>
    </div>
  );
}

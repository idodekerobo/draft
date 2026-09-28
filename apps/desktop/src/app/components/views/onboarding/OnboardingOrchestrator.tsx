// OnboardingOrchestrator.tsx — state + handler hub for the onboarding wizard
//
// Active steps:
//   1. Welcome        — what Draft is
//   2. Cloud sign-in  — skipped when already signed in with a resolved workspace at mount
//   3. Connect Claude Code
//   4. Integrations   — connect Slack and Fireflies inline
//   5. Context setup  — cloud bootstrap (local-folder upload + trigger synthesis)
//   6. Collab         — invite link for teammates
//   7. Finalize       — analytics consent
//
// TODO: path-choice of solo/join-team, native GitHub OAuth
// device flow to a shared context repo, ScanImportStep, ProfileStep are commented out
// getActiveProfile() already falls back to "default" when no profile is chosen
// underlying getProfiles/switchProfile/createProfile RPCs are still used elsewhere

import { useState, useEffect, useRef, useCallback } from "react";
import type { ConnectedAppsStatus } from "../../../../rpc/schema";
import { rpc } from "../../../rpc";
import { useAnalytics } from "../../../analytics/AnalyticsContext";
import type { OnboardingStep } from "../../../types";
import { WelcomeStep } from "./WelcomeStep";
// import { PathChoiceStep } from "./PathChoiceStep"; // TODO: see note above
// import { ProfileStep } from "./ProfileStep"; // TODO: see note above
import { ConnectClaudeCodeStep } from "./ConnectClaudeCodeStep";
import { IntegrationSetupStep } from "./IntegrationSetupStep";
import { CompleteStep } from "./CompleteStep";
// import { ScanImportStep } from "./ScanImportStep"; // TODO: see note above
import { HeadlessSetupStep } from "./HeadlessSetupStep";
import { CollabStep } from "./CollabStep";
// import { JoinTeamStep } from "./JoinTeamStep"; // TODO: see note above
import { CloudSignInStep } from "./CloudSignInStep";
import { useUserIdentity } from "../../../identity/UserIdentityContext";

const BASE_STEPS: OnboardingStep[] = [
  "welcome", "cloud-sign-in", "intelligence-tools", "integrations", "headless-setup", "collab", "complete",
];

interface OnboardingOrchestratorProps {
  onComplete: () => void;
}

export function OnboardingOrchestrator({ onComplete }: OnboardingOrchestratorProps) {
  const [step, setStep]               = useState<OnboardingStep>("welcome");
  const [consentSaving, setConsentSaving] = useState(false);
  const [consentAnswered, setConsentAnswered] = useState(false);

  // Lifted here (rather than owned by IntegrationSetupStep) so it survives
  // the step remounting when the user navigates away and back — otherwise
  // connections resets to null on every remount and briefly flashes
  // "unconnected" until getConnectedApps() resolves again.
  const [connections, setConnections] = useState<ConnectedAppsStatus["integrations"] | null>(null);
  const loadConnections = useCallback(async (): Promise<boolean> => {
    try {
      const result = await rpc.request.getConnectedApps();
      setConnections(result.integrations);
      return true;
    } catch {
      return false;
    }
  }, []);
  useEffect(() => { void loadConnections(); }, [loadConnections]);

  const { track, setConsent, setReplayEnabled } = useAnalytics();
  const identity = useUserIdentity();
  const { workspaceId } = identity;
  const completedRef = useRef(false);
  const stepRef      = useRef<OnboardingStep>(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  // Track step views
  useEffect(() => {
    track("onboarding_step_viewed", { step });
  }, [step]);

  const [skipCloudSignIn, setSkipCloudSignIn] = useState<boolean | null>(null);
  useEffect(() => {
    if (skipCloudSignIn !== null || !identity.hydrated) return;
    setSkipCloudSignIn(Boolean(identity.workspaceId));
  }, [identity.hydrated, identity.workspaceId, skipCloudSignIn]);

  const activeSteps: OnboardingStep[] = skipCloudSignIn
    ? BASE_STEPS.filter((currentStep) => currentStep !== "cloud-sign-in")
    : BASE_STEPS;

  // Fallback for the race where identity hydration resolves (already signed
  // in) after the user has already landed on cloud-sign-in but before
  // skipCloudSignIn above has been decided — guarded to fire once 
  const autoSkippedCloudSignIn = useRef(false);
  useEffect(() => {
    if (step === "cloud-sign-in" && workspaceId && !autoSkippedCloudSignIn.current) {
      autoSkippedCloudSignIn.current = true;
      goNext();
    }
  }, [step, workspaceId]);

  // Fire abandoned if component unmounts before completion
  useEffect(() => {
    return () => {
      if (!completedRef.current) {
        track("onboarding_abandoned", { last_step: stepRef.current });
      }
    };
  }, []);

  // TODO: profile step — see file-header note. Onboarding no longer visits
  // "profile", so this local-desktop-profile create/select state and its
  // handlers have no active caller right now. Left here for reference
  // rather than deleted, matching the treatment of the other removed steps.
  //
  // const [profileList, setProfileList]       = useState<ProfileDetail[]>([]);
  // const [profilesLoaded, setProfilesLoaded] = useState(false);
  // const [newProfileName, setNewProfileName] = useState("");
  // const [profileError, setProfileError]     = useState<string | null>(null);
  // const [settingProfile, setSettingProfile] = useState(false);
  //
  // useEffect(() => {
  //   if (step !== "profile") return;
  //   rpc.request.getProfiles()
  //     .then((pl) => { setProfileList(pl.details); setProfilesLoaded(true); })
  //     .catch(() => setProfilesLoaded(true));
  // }, [step]);
  //
  // async function handleSelectProfile(name: string) {
  //   setSettingProfile(true);
  //   setProfileError(null);
  //   try {
  //     const result = await rpc.request.switchProfile({ profile: name });
  //     if (result.ok) {
  //       track("profile_actioned", { action: "selected" });
  //       goNext();
  //     } else {
  //       setProfileError(result.error ?? "Switch failed.");
  //     }
  //   } catch {
  //     setProfileError("Switch failed.");
  //   } finally {
  //     setSettingProfile(false);
  //   }
  // }
  //
  // async function handleCreateProfile() {
  //   const trimmed = newProfileName.trim();
  //   if (!trimmed) return;
  //   setSettingProfile(true);
  //   setProfileError(null);
  //   try {
  //     const result = await rpc.request.createProfile({ name: trimmed });
  //     if (result.ok) {
  //       track("profile_actioned", { action: "created" });
  //       goNext();
  //     } else {
  //       setProfileError(result.error ?? "Create failed.");
  //     }
  //   } catch {
  //     setProfileError("Create failed.");
  //   } finally {
  //     setSettingProfile(false);
  //   }
  // }

  async function handleConsent(granted: boolean) {
    setConsentSaving(true);
    try {
      if (granted) await setReplayEnabled(true); // must run before setConsent so _initPostHog picks up replay_enabled:true
      await setConsent(granted);
      if (granted) track("analytics_consent_granted", {});
    } finally {
      setConsentSaving(false);
      setConsentAnswered(true);
    }
  }

  async function handleStart() {
    completedRef.current = true;
    track("onboarding_completed", { tools_selected: ["claude-code"] });
    try {
      await rpc.request.completeOnboarding();
    } finally {
      onComplete();
    }
  }

  function goNext() {
    const next = activeSteps[activeSteps.indexOf(step) + 1];
    if (next) setStep(next);
  }

  function handleBack() {
    const previous = activeSteps[activeSteps.indexOf(step) - 1];
    if (previous) setStep(previous);
  }

  const stepNum = activeSteps.indexOf(step) + 1;
  const totalSteps = activeSteps.length;

  return (
    <div className="onboarding">
      {step === "welcome" && (
        <WelcomeStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onNext={goNext}
        />
      )}
      {step === "cloud-sign-in" && (
        <CloudSignInStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          onNext={goNext}
        />
      )}
      {/* TODO: path-choice — see file-header note */}
      {/* TODO: profile — see file-header note */}
      {/* TODO: join-team — see file-header note */}
      {step === "intelligence-tools" && (
        <ConnectClaudeCodeStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          onNext={goNext}
        />
      )}
      {step === "integrations" && (
        <IntegrationSetupStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          onNext={goNext}
          connections={connections}
          loadConnections={loadConnections}
        />
      )}
      {/* TODO: scan-import — see file-header note */}
      {step === "headless-setup" && (
        <HeadlessSetupStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          onNext={goNext}
        />
      )}
      {step === "collab" && (
        <CollabStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          onNext={goNext}
        />
      )}
      {step === "complete" && (
        <CompleteStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          handleStart={handleStart}
          consentAnswered={consentAnswered}
          consentSaving={consentSaving}
          handleConsent={handleConsent}
        />
      )}
    </div>
  );
}

// OnboardingOrchestrator.tsx — state + handler hub for the onboarding wizard
//
// At most eight active steps:
//   1. Welcome  — what Draft is, three-component architecture
//   2. Profile  — create / pick workspace (BEFORE install — install needs active-profile)
//   3. Install  — tool selection + install (calls runInstall RPC)
//   4. Scan + import — skipped when no third-party skills exist
//   5. Integrations — connect Granola, Fireflies, Slack, and GitHub inline
//   6. Context setup — optional headless setup with manual fallback
//   7. Collab — team collaboration awareness
//   8. Finalize — analytics consent and daemon start

import { useState, useEffect, useRef } from "react";
import type { InstallableTool, InstallStep, ProfileDetail } from "../../../../rpc/schema";
import { rpc } from "../../../rpc";
import { useAnalytics } from "../../../analytics/AnalyticsContext";
import type { OnboardingPath, OnboardingStep } from "../../../types";
import { TOOL_PREREQS } from "./constants";
import { WelcomeStep } from "./WelcomeStep";
import { PathChoiceStep } from "./PathChoiceStep";
import { ProfileStep } from "./ProfileStep";
import { ToolSelectionStep } from "./ToolSelectionStep";
import { IntegrationSetupStep } from "./IntegrationSetupStep";
import { CompleteStep } from "./CompleteStep";
import { ScanImportStep } from "./ScanImportStep";
import { HeadlessSetupStep } from "./HeadlessSetupStep";
import { CollabStep } from "./CollabStep";
import { JoinTeamStep } from "./JoinTeamStep";

const SOLO_BASE_STEPS: OnboardingStep[] = [
  "welcome", "path-choice", "profile", "intelligence-tools", "integrations", "headless-setup", "collab", "complete",
];
const SOLO_SCAN_STEPS: OnboardingStep[] = [
  "welcome", "path-choice", "profile", "intelligence-tools", "scan-import", "integrations", "headless-setup", "collab", "complete",
];
const JOIN_STEPS: OnboardingStep[] = [
  "welcome", "path-choice", "profile", "join-team", "intelligence-tools", "integrations", "complete",
];

interface OnboardingOrchestratorProps {
  onComplete: () => void;
}

export function OnboardingOrchestrator({ onComplete }: OnboardingOrchestratorProps) {
  const [step, setStep]               = useState<OnboardingStep>("welcome");
  const [selected, setSelected]       = useState<Set<InstallableTool>>(new Set(["claude-code"]));
  const [installing, setInstalling]   = useState(false);
  const [steps, setSteps]             = useState<InstallStep[]>([]);
  const [installError, setInstallError] = useState<string | null>(null);
  const [isStarting, setIsStarting]   = useState(false);
  const [showContinue, setShowContinue] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);
  const [consentAnswered, setConsentAnswered] = useState(false);
  const [hasScannableSkills, setHasScannableSkills] = useState<boolean | null>(null);
  const [onboardingPath, setOnboardingPath] = useState<OnboardingPath | null>(null);
  const [joinAvailable, setJoinAvailable] = useState(false);

  const { track, setConsent, setReplayEnabled } = useAnalytics();
  const completedRef = useRef(false);
  const stepRef      = useRef<OnboardingStep>(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  // Track step views
  useEffect(() => {
    track("onboarding_step_viewed", { step });
  }, [step]);

  useEffect(() => {
    // Fires unconditionally on mount, before any path is chosen, against
    // whatever profile is currently active (not the one being created). Its
    // result only feeds the solo-path variant selection below — it has zero
    // effect on the join path, which never renders scan-import regardless.
    rpc.request.scanSkills()
      .then((result) => setHasScannableSkills(result.skills.length > 0))
      // Preserve the step on scan failure so it can show its retry/skip UI.
      .catch(() => setHasScannableSkills(true));
  }, []);

  useEffect(() => {
    rpc.request.getGitHubJoinConfig()
      .then((cfg) => setJoinAvailable(cfg.enabled))
      .catch(() => setJoinAvailable(false));
  }, []);

  const soloSteps = hasScannableSkills === false && step !== "scan-import" ? SOLO_BASE_STEPS : SOLO_SCAN_STEPS;
  const activeSteps: OnboardingStep[] = onboardingPath === "join" ? JOIN_STEPS : soloSteps;

  // Fire abandoned if component unmounts before completion
  useEffect(() => {
    return () => {
      if (!completedRef.current) {
        track("onboarding_abandoned", { last_step: stepRef.current });
      }
    };
  }, []);

  // ── Profile step ──────────────────────────────────────────────────────────────

  const [profileList, setProfileList]       = useState<ProfileDetail[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [profileError, setProfileError]     = useState<string | null>(null);
  const [settingProfile, setSettingProfile] = useState(false);

  // Delay "Continue anyway" so it can't be hit in the same click as Install.
  useEffect(() => {
    if (!installError) { setShowContinue(false); return; }
    const t = setTimeout(() => setShowContinue(true), 1_000);
    return () => clearTimeout(t);
  }, [installError]);

  // Load profile list when profile step becomes active.
  useEffect(() => {
    if (step !== "profile") return;
    rpc.request.getProfiles()
      .then((pl) => { setProfileList(pl.details); setProfilesLoaded(true); })
      .catch(() => setProfilesLoaded(true));
  }, [step]);

  async function handleSelectProfile(name: string) {
    setSettingProfile(true);
    setProfileError(null);
    try {
      const result = await rpc.request.switchProfile({ profile: name });
      if (result.ok) {
        track("profile_actioned", { action: "selected" });
        goNext();
      } else {
        setProfileError(result.error ?? "Switch failed.");
      }
    } catch {
      setProfileError("Switch failed.");
    } finally {
      setSettingProfile(false);
    }
  }

  async function handleCreateProfile() {
    const trimmed = newProfileName.trim();
    if (!trimmed) return;
    setSettingProfile(true);
    setProfileError(null);
    try {
      const result = await rpc.request.createProfile({ name: trimmed });
      if (result.ok) {
        track("profile_actioned", { action: "created" });
        goNext();
      } else {
        setProfileError(result.error ?? "Create failed.");
      }
    } catch {
      setProfileError("Create failed.");
    } finally {
      setSettingProfile(false);
    }
  }

  const prereqTools = [...selected]
    .filter((id): id is keyof typeof TOOL_PREREQS => id in TOOL_PREREQS)
    .map((id) => ({ id, ...TOOL_PREREQS[id]! }));

  function toggleTool(id: InstallableTool) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleInstall() {
    if (selected.size === 0) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await rpc.request.runInstall({ tools: [...selected] });
      setSteps(result.steps);
      if (result.ok) {
        for (const tool of selected) track("tool_installed", { tool });
        setInstallError(null);
        setSteps([]);
        goNext();
      } else {
        const failedStep = result.steps.find((s) => !s.ok);
        for (const tool of selected) {
          track("install_failed", { tool, step_label: failedStep?.label ?? "unknown" });
        }
        setInstallError("Some steps failed. You can continue or try again.");
      }
    } catch {
      for (const tool of selected) {
        track("install_failed", { tool, step_label: "rpc_error" });
      }
      setInstallError("Installation failed. Try again, or continue and run `draft add claude-code` in your terminal to finish setup.");
    } finally {
      setInstalling(false);
    }
  }

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
    setIsStarting(true);
    completedRef.current = true;
    track("onboarding_completed", { tools_selected: [...selected] });
    try {
      await rpc.request.startDaemon();
      await rpc.request.startSkillWatcher();
    } finally {
      setIsStarting(false);
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
      {step === "path-choice" && (
        <PathChoiceStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          joinAvailable={joinAvailable}
          onChoose={(path) => {
            track("onboarding_path_chosen", { path });
            setOnboardingPath(path);
            goNext();
          }}
        />
      )}
      {step === "profile" && (
        <ProfileStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          profileList={profileList}
          profilesLoaded={profilesLoaded}
          newProfileName={newProfileName}
          setNewProfileName={setNewProfileName}
          profileError={profileError}
          settingProfile={settingProfile}
          handleSelectProfile={handleSelectProfile}
          handleCreateProfile={handleCreateProfile}
          restrictToNewProfile={onboardingPath === "join"}
        />
      )}
      {step === "join-team" && (
        <JoinTeamStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          onNext={goNext}
        />
      )}
      {step === "intelligence-tools" && (
        <ToolSelectionStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          selected={selected}
          toggleTool={toggleTool}
          installing={installing}
          steps={steps}
          installError={installError}
          showContinue={showContinue}
          handleInstall={handleInstall}
          prereqTools={prereqTools}
          onSkip={() => {
            track("install_skipped", { tools: [...selected] });
            goNext();
          }}
        />
      )}
      {step === "integrations" && (
        <IntegrationSetupStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          onNext={goNext}
        />
      )}
      {step === "scan-import" && (
        <ScanImportStep
          stepNum={stepNum}
          totalSteps={totalSteps}
          onBack={handleBack}
          onNext={goNext}
        />
      )}
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
          isStarting={isStarting}
          handleStart={handleStart}
          consentAnswered={consentAnswered}
          consentSaving={consentSaving}
          handleConsent={handleConsent}
        />
      )}
    </div>
  );
}

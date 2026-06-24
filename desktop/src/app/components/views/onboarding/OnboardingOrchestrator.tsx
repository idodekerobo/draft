// OnboardingOrchestrator.tsx — state + handler hub for the onboarding wizard
//
// Seven steps:
//   1. Welcome  — what Draft is, three-component architecture
//   2. Profile  — create / pick workspace (BEFORE install — install needs active-profile)
//   3. Install  — tool selection + install (calls runInstall RPC)
//   5. Integrations — connect Granola, Slack, and GitHub inline
//   5. Collab   — team collaboration awareness — skippable
//   6. Consent  — analytics opt-in/out (embedded inline, replaces post-onboarding modal)
//   7. Done     — /draft-setup CTA + tray/background note + Start Draft

import { useState, useEffect, useRef } from "react";
import type { InstallableTool, InstallStep, ProfileDetail } from "../../../../rpc/schema";
import { rpc } from "../../../rpc";
import { useAnalytics } from "../../../analytics/AnalyticsContext";
import type { OnboardingStep } from "../../../types";
import { TOOL_PREREQS } from "./constants";
import { WelcomeStep } from "./WelcomeStep";
import { ProfileStep } from "./ProfileStep";
import { ToolSelectionStep } from "./ToolSelectionStep";
import { IntegrationSetupStep } from "./IntegrationSetupStep";
import { CollabStep } from "./CollabStep";
import { ConsentStep } from "./ConsentStep";
import { CompleteStep } from "./CompleteStep";
import { ScanImportStep } from "./ScanImportStep";
import { HeadlessSetupStep } from "./HeadlessSetupStep";

const STEP_NUMBER: Record<OnboardingStep, number> = {
  welcome:     1,
  profile:     2,
  "intelligence-tools": 3,
  "scan-import": 4,
  integrations: 5,
  collab:      6,
  "headless-setup": 7,
  consent:     8,
  complete:    9,
};
const TOTAL_STEPS = 9;

const PREV_STEP: Partial<Record<OnboardingStep, OnboardingStep>> = {
  profile:       "welcome",
  "intelligence-tools": "profile",
  "scan-import": "intelligence-tools",
  integrations:  "scan-import",
  collab:        "integrations",
  "headless-setup": "collab",
  consent:       "headless-setup",
  complete:      "consent",
};

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

  const { track, setConsent, setReplayEnabled } = useAnalytics();
  const completedRef = useRef(false);
  const stepRef      = useRef<OnboardingStep>(step);
  useEffect(() => { stepRef.current = step; }, [step]);

  // Track step views
  useEffect(() => {
    track("onboarding_step_viewed", { step });
  }, [step]);

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
        setStep("intelligence-tools");
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
        setStep("intelligence-tools");
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
        setStep("scan-import");
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
      setStep("complete");
    }
  }

  async function handleStart() {
    setIsStarting(true);
    completedRef.current = true;
    track("onboarding_completed", { tools_selected: [...selected] });
    try {
      await rpc.request.startDaemon();
    } finally {
      setIsStarting(false);
      onComplete();
    }
  }

  function handleBack() {
    const prev = PREV_STEP[step];
    if (prev) setStep(prev);
  }

  const stepNum = STEP_NUMBER[step];

  return (
    <div className="onboarding">
      {step === "welcome" && (
        <WelcomeStep
          stepNum={stepNum}
          totalSteps={TOTAL_STEPS}
          onNext={() => setStep("profile")}
        />
      )}
      {step === "profile" && (
        <ProfileStep
          stepNum={stepNum}
          totalSteps={TOTAL_STEPS}
          onBack={handleBack}
          profileList={profileList}
          profilesLoaded={profilesLoaded}
          newProfileName={newProfileName}
          setNewProfileName={setNewProfileName}
          profileError={profileError}
          settingProfile={settingProfile}
          handleSelectProfile={handleSelectProfile}
          handleCreateProfile={handleCreateProfile}
        />
      )}
      {step === "intelligence-tools" && (
        <ToolSelectionStep
          stepNum={stepNum}
          totalSteps={TOTAL_STEPS}
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
            setStep("scan-import");
          }}
        />
      )}
      {step === "integrations" && (
        <IntegrationSetupStep
          stepNum={stepNum}
          totalSteps={TOTAL_STEPS}
          onBack={handleBack}
          onNext={() => setStep("collab")}
        />
      )}
      {step === "scan-import" && (
        <ScanImportStep
          stepNum={stepNum}
          totalSteps={TOTAL_STEPS}
          onBack={handleBack}
          onNext={() => setStep("integrations")}
        />
      )}
      {step === "collab" && (
        <CollabStep
          stepNum={stepNum}
          totalSteps={TOTAL_STEPS}
          onBack={handleBack}
          onNext={() => setStep("headless-setup")}
        />
      )}
      {step === "headless-setup" && (
        <HeadlessSetupStep
          stepNum={stepNum}
          totalSteps={TOTAL_STEPS}
          onBack={handleBack}
          onNext={() => setStep("consent")}
        />
      )}
      {step === "consent" && (
        <ConsentStep
          stepNum={stepNum}
          totalSteps={TOTAL_STEPS}
          onBack={handleBack}
          consentSaving={consentSaving}
          handleConsent={handleConsent}
        />
      )}
      {step === "complete" && (
        <CompleteStep
          stepNum={stepNum}
          totalSteps={TOTAL_STEPS}
          onBack={handleBack}
          isStarting={isStarting}
          handleStart={handleStart}
        />
      )}
    </div>
  );
}

// OnboardingView.tsx — first-launch install wizard
//
// Shown when appState.userState === "first-run" (no ~/.draft/active-profile).
// Four steps:
//   1. Welcome
//   2. Workspace — create a new profile or pick an existing one (BEFORE install
//      so that `draft add` sees an existing active-profile and skips its own prompt)
//   3. Tool selection + install (calls runInstall RPC)
//   4. Done — start Draft

import { useState, useEffect } from "react";
import type { InstallableTool, InstallStep, ProfileDetail } from "../../../rpc/schema";
import { rpc } from "../../rpc";

type Step = "welcome" | "install" | "profile" | "done";

interface ToolOption {
  id: InstallableTool;
  name: string;
  description: string;
}

const TOOL_PREREQS: Partial<Record<InstallableTool, { label: string; url: string }>> = {
  "claude-code": {
    label: "Claude Code CLI",
    url: "https://code.claude.com/docs/en/quickstart",
  },
  codex: {
    label: "Codex CLI",
    url: "https://developers.openai.com/codex/cli",
  },
};

const TOOL_OPTIONS: ToolOption[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Context injected at the start of every Claude Code session",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Context injected at the start of every Codex session",
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Context applied via Cursor rules on every session start",
  },
];

interface OnboardingViewProps {
  onComplete: () => void;
}

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [step, setStep]           = useState<Step>("welcome");
  const [selected, setSelected]   = useState<Set<InstallableTool>>(new Set(["claude-code"]));
  const [installing, setInstalling] = useState(false);
  const [steps, setSteps]         = useState<InstallStep[]>([]);
  const [installError, setInstallError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [showContinue, setShowContinue] = useState(false);

  // Profile step state
  const [profileList, setProfileList]     = useState<ProfileDetail[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [profileError, setProfileError]   = useState<string | null>(null);
  const [settingProfile, setSettingProfile] = useState(false);

  // Delay "Continue anyway" so it can't be hit in the same click as Install.
  useEffect(() => {
    if (!installError) { setShowContinue(false); return; }
    const t = setTimeout(() => setShowContinue(true), 1000);
    return () => clearTimeout(t);
  }, [installError]);

  // Load profile list when the profile step becomes active.
  useEffect(() => {
    if (step !== "profile") return;
    rpc.request.getProfiles().then((pl) => {
      setProfileList(pl.details);
      setProfilesLoaded(true);
    }).catch(() => setProfilesLoaded(true));
  }, [step]);

  async function handleSelectProfile(name: string) {
    setSettingProfile(true);
    setProfileError(null);
    try {
      const result = await rpc.request.switchProfile({ profile: name });
      if (result.ok) {
        setStep("install");
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
        setStep("install");
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
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
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
        setInstallError(null);
        setSteps([]);
        setStep("done");
      } else {
        // Show results inline — user can still proceed after seeing errors
        setInstallError("Some steps failed. You can continue or try again.");
      }
    } catch {
      setInstallError("Installation failed. Try again, or continue and run `draft add claude-code` in your terminal to finish setup.");
    } finally {
      setInstalling(false);
    }
  }

  async function handleStart() {
    setIsStarting(true);
    try {
      await rpc.request.startDaemon();
    } finally {
      setIsStarting(false);
      onComplete();
    }
  }

  return (
    <div className="onboarding">
      {step === "welcome" && (
        <div className="onboarding__body">
          <p className="onboarding__step-indicator">Step 1 of 4</p>
          <h1 className="onboarding__title">Set up Draft</h1>
          <p className="onboarding__desc">
            Draft runs in the background, capturing context from your meetings,
            Slack, and coding sessions. Every Claude Code session starts with
            everything your agent needs to know.
          </p>
          <button
            className="empty-state__cta onboarding__cta"
            onClick={() => setStep("profile")}
          >
            Get started
          </button>
        </div>
      )}

      {step === "install" && (
        <div className="onboarding__body">
          <p className="onboarding__step-indicator">Step 3 of 4</p>
          <h1 className="onboarding__title">Choose your tools</h1>
          <p className="onboarding__desc">
            Select the coding tools you use. Draft will inject context at the
            start of each session.
          </p>

          {prereqTools.length > 0 && (
            <div className="onboarding__prereq">
              <span className="onboarding__prereq-label">Prerequisite</span>
              {prereqTools.map((tool) => (
                <div key={tool.id} className="onboarding__prereq-row">
                  <span className="onboarding__prereq-tool">{tool.label}</span>
                  <button
                    className="onboarding__prereq-link"
                    onClick={() => rpc.send.openUrl({ url: tool.url })}
                  >
                    Install ↗
                  </button>
                </div>
              ))}
              <span className="onboarding__prereq-note">
                CLI tools only — not the desktop apps. Make sure you're logged in before installing.
              </span>
            </div>
          )}

          <div className="onboarding__tool-list">
            {TOOL_OPTIONS.map((tool) => (
              <button
                key={tool.id}
                className={`onboarding__tool-row${selected.has(tool.id) ? " onboarding__tool-row--selected" : ""}`}
                onClick={() => !installing && toggleTool(tool.id)}
                disabled={installing}
              >
                <span className="onboarding__tool-check">
                  {selected.has(tool.id) ? "✓" : ""}
                </span>
                <span className="onboarding__tool-text">
                  <span className="onboarding__tool-name">{tool.name}</span>
                  <span className="onboarding__tool-desc">{tool.description}</span>
                </span>
              </button>
            ))}
          </div>

          {/* Per-step install progress */}
          {steps.length > 0 && (
            <div className="onboarding__progress">
              {steps.map((s, i) => (
                <div key={i} className="onboarding__progress-row">
                  <span className={`onboarding__progress-icon${s.ok ? " onboarding__progress-icon--ok" : " onboarding__progress-icon--fail"}`}>
                    {s.ok ? "✓" : "✕"}
                  </span>
                  <span className="onboarding__progress-label">{s.label}</span>
                  {!s.ok && s.error && (
                    <span className="onboarding__progress-error">{s.error}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {installError && (
            <p className="onboarding__error">{installError}</p>
          )}

          <div className="onboarding__actions">
            <button
              className="empty-state__cta onboarding__cta"
              onClick={handleInstall}
              disabled={installing || selected.size === 0}
            >
              {installing ? "Installing…" : "Install"}
            </button>
            {showContinue && (
              <button
                className="onboarding__skip"
                onClick={() => setStep("done")}
              >
                Continue anyway
              </button>
            )}
          </div>
        </div>
      )}

      {step === "profile" && (
        <div className="onboarding__body">
          <p className="onboarding__step-indicator">Step 2 of 4</p>
          <h1 className="onboarding__title">Name your workspace</h1>

          <div className="onboarding__education">
            <span className="onboarding__education-icon">⬡</span>
            <div className="onboarding__education-text">
              <strong>What's a workspace?</strong>
              <span>
                A workspace stores the product context Draft captures for one
                project — your team, goals, and decisions. Claude Code reads it
                at the start of every session. One workspace per product.
              </span>
            </div>
          </div>

          {profilesLoaded && profileList.length > 0 && (
            <>
              <p className="onboarding__desc" style={{ marginBottom: 10 }}>
                You have existing workspaces — pick one or create a new one.
              </p>
              <div className="onboarding__tool-list">
                {profileList.map((p) => (
                  <button
                    key={p.name}
                    className="onboarding__tool-row"
                    onClick={() => !settingProfile && handleSelectProfile(p.name)}
                    disabled={settingProfile}
                  >
                    <span className="onboarding__tool-check" />
                    <span className="onboarding__tool-text">
                      <span className="onboarding__tool-name">{p.name}</span>
                      <span className="onboarding__tool-desc">
                        {p.hasContext ? "Context ready" : "Empty — populate with /draft-setup"}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <div className="setup-incomplete__divider"><span>or create new</span></div>
            </>
          )}

          <div className="setup-incomplete__create-form">
            <input
              className="setup-incomplete__create-input"
              type="text"
              placeholder="e.g. acme, my-startup"
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreateProfile()}
              autoFocus
            />
            <button
              className="empty-state__cta onboarding__cta"
              onClick={handleCreateProfile}
              disabled={!newProfileName.trim() || settingProfile}
            >
              {settingProfile ? "Creating…" : "Create"}
            </button>
          </div>

          {profileError && <p className="onboarding__error">{profileError}</p>}
        </div>
      )}

      {step === "done" && (
        <div className="onboarding__body">
          <p className="onboarding__step-indicator">Step 4 of 4</p>
          <h1 className="onboarding__title">One last thing</h1>
          <p className="onboarding__desc">
            Before starting Draft, populate your workspace with your product
            context.
          </p>
          <div className="onboarding__education">
            <span className="onboarding__education-icon">①</span>
            <div className="onboarding__education-text">
              <strong>Open Claude Code and run</strong>
              <span>
                <code className="onboarding__code">/draft-setup</code>
                {" "}— this walks you through adding your team, goals, and
                decisions so Draft has something to inject into every session.
              </span>
            </div>
          </div>
          <button
            className="empty-state__cta onboarding__cta"
            onClick={handleStart}
            disabled={isStarting}
          >
            {isStarting ? "Starting…" : "Start Draft"}
          </button>
        </div>
      )}
    </div>
  );
}

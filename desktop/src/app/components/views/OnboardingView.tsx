// OnboardingView.tsx — first-launch install wizard
//
// Seven steps:
//   1. Welcome  — what Draft is, three-component architecture
//   2. Profile  — create / pick workspace (BEFORE install — install needs active-profile)
//   3. Install  — tool selection + install (calls runInstall RPC)
//   4. Inputs   — connect input sources; GitHub connects inline via OAuth
//   5. Collab   — team collaboration awareness — skippable
//   6. Consent  — analytics opt-in/out (embedded inline, replaces post-onboarding modal)
//   7. Done     — /draft-setup CTA + tray/background note + Start Draft

import { useState, useEffect, useRef } from "react";
import type { InstallableTool, InstallStep, ProfileDetail } from "../../../rpc/schema";
import { rpc } from "../../rpc";
import { useAnalytics } from "../../analytics/AnalyticsContext";
import type { OnboardingStep } from "../../types";

const STEP_NUMBER: Record<OnboardingStep, number> = {
  welcome:     1,
  profile:     2,
  "intelligence-tools": 3,
  inputs:      4,
  collab:      5,
  consent:     6,
  complete:    7,
};
const TOTAL_STEPS = 7;

const PREV_STEP: Partial<Record<OnboardingStep, OnboardingStep>> = {
  profile:       "welcome",
  "intelligence-tools": "profile",
  inputs:        "intelligence-tools",
  collab:        "inputs",
  consent:       "collab",
  complete:      "consent",
};

// ── Copyable command chip ───────────────────────────────────────────────────────

function CopyableCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  function handleCopy() {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    });
  }
  return (
    <button className="onboarding__cmd" onClick={handleCopy} title="Copy to clipboard">
      <span className="onboarding__cmd-text">{cmd}</span>
      <span className="onboarding__cmd-copy">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

// ── Tool options ────────────────────────────────────────────────────────────────

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
  cursor: {
    label: "Cursor",
    url: "https://cursor.com/get-started",
  },
  openclaw: {
    label: "OpenClaw CLI",
    url: "https://docs.openclaw.ai/",
  },
  hermes: {
    label: "Hermes CLI",
    url: "https://hermes-agent.nousresearch.com/docs/getting-started/quickstart",
  },
};

const TOOL_OPTIONS: ToolOption[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Context injected at session start · post-session synthesis",
  },
  {
    id: "codex",
    name: "Codex",
    description: "Context injected at session start · post-session synthesis",
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Context applied via Cursor rules at session start",
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    description: "Context injected at session start · post-session synthesis",
  },
  {
    id: "hermes",
    name: "Hermes",
    description: "Context injected at session start · post-session synthesis",
  },
];

// ── OnboardingView ──────────────────────────────────────────────────────────────

interface OnboardingViewProps {
  onComplete: () => void;
}

export function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [step, setStep]               = useState<OnboardingStep>("welcome");
  const [selected, setSelected]       = useState<Set<InstallableTool>>(new Set(["claude-code"]));
  const [installing, setInstalling]   = useState(false);
  const [steps, setSteps]             = useState<InstallStep[]>([]);
  const [installError, setInstallError] = useState<string | null>(null);
  const [isStarting, setIsStarting]   = useState(false);
  const [showContinue, setShowContinue] = useState(false);
  const [consentSaving, setConsentSaving] = useState(false);

  // GitHub connect state (inputs step)
  const [connectingGitHub, setConnectingGitHub] = useState(false);
  const [githubConnected, setGithubConnected]   = useState(false);
  const [githubError, setGithubError]           = useState<string | null>(null);

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

  // Load initial GitHub connection status when inputs step becomes active.
  useEffect(() => {
    if (step !== "inputs") return;
    rpc.request.getConnectedApps()
      .then((apps) => setGithubConnected(apps.integrations.github.connected))
      .catch(() => {});
  }, [step]);

  // Poll getConnectedApps while GitHub OAuth is in progress.
  useEffect(() => {
    if (!connectingGitHub) return;
    const id = setInterval(async () => {
      try {
        const updated = await rpc.request.getConnectedApps();
        if (updated.integrations.github.connected) {
          setGithubConnected(true);
          setConnectingGitHub(false);
          track("integration_connected", { source: "github" });
        }
      } catch { /* keep polling */ }
    }, 2_000);
    const timeout = setTimeout(() => {
      setConnectingGitHub(false);
      setGithubError("GitHub sign-in timed out. Try again.");
    }, 5 * 60 * 1_000);
    return () => { clearInterval(id); clearTimeout(timeout); };
  }, [connectingGitHub]);

  async function handleSelectProfile(name: string) {
    setSettingProfile(true);
    setProfileError(null);
    try {
      const result = await rpc.request.switchProfile({ profile: name });
      if (result.ok) {
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
        setStep("inputs");
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

  async function handleConnectGitHub() {
    setConnectingGitHub(true);
    setGithubError(null);
    try {
      const result = await rpc.request.connectGitHub();
      if (!result.ok) {
        setGithubError(result.error ?? "GitHub connect failed.");
        setConnectingGitHub(false);
      }
      // On ok:true the OAuth browser flow is open — polling effect takes over.
    } catch {
      setGithubError("GitHub connect failed.");
      setConnectingGitHub(false);
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

      {/* ── Step 1: Welcome ─────────────────────────────────────────────────── */}
      {step === "welcome" && (
        <div className="onboarding__body">
          <p className="onboarding__step-indicator">Step {stepNum} of {TOTAL_STEPS}</p>
          <h1 className="onboarding__title">Draft keeps your AI agent sessions grounded.</h1>
          <p className="onboarding__desc">
            Works with Claude Code, Codex, and Cursor. Draft runs quietly in the
            background, capturing context from your meetings, Slack, and coding
            sessions — then injects what your agent needs to know at the start of
            every session.
          </p>

          <div className="onboarding__arch">
            <div className="onboarding__arch-row">
              <span className="onboarding__arch-label">Desktop app</span>
              <span className="onboarding__arch-desc">Background capture, proposals, context browser</span>
            </div>
            <div className="onboarding__arch-row">
              <span className="onboarding__arch-label">CLI (draft)</span>
              <span className="onboarding__arch-desc">Full terminal control — every desktop feature, as commands</span>
            </div>
            <div className="onboarding__arch-row">
              <span className="onboarding__arch-label">Plugin</span>
              <span className="onboarding__arch-desc">Injected into Claude Code, Codex, and Cursor at session start</span>
            </div>
          </div>

          <p className="onboarding__hint">
            All three work together.
            <br/>
            Draft captures and synthesizes context in the
            background; the plugin injects it when each agent session starts.
            <br/>
            You can run and control Draft entirely from the terminal if you prefer.
            <br/>
            <br/>
            <b>Works solo or share and collaborate on context with your whole team.</b>
          </p>

          <button
            className="empty-state__cta onboarding__cta"
            style={{ marginTop: 20 }}
            onClick={() => setStep("profile")}
          >
            Get started
          </button>
        </div>
      )}

      {/* ── Step 2: Profile ─────────────────────────────────────────────────── */}
      {step === "profile" && (
        <div className="onboarding__body">
          <div className="onboarding__nav">
            <button className="onboarding__back" onClick={handleBack}>← Back</button>
            <p className="onboarding__step-indicator">Step {stepNum} of {TOTAL_STEPS}</p>
          </div>
          <h1 className="onboarding__title">Name your workspace</h1>

          <div className="onboarding__education">
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

      {/* ── Step 3: Install ─────────────────────────────────────────────────── */}
      {step === "intelligence-tools" && (
        <div className="onboarding__body">
          <div className="onboarding__nav">
            <button className="onboarding__back" onClick={handleBack}>← Back</button>
            <p className="onboarding__step-indicator">Step {stepNum} of {TOTAL_STEPS}</p>
          </div>
          <h1 className="onboarding__title">Choose your AI tools</h1>
          <p className="onboarding__desc">
            Select the tools you use. Draft connects to each one in two ways.
          </p>

          <div className="onboarding__section-group">
            <p className="onboarding__section-label">WHAT GETS INJECTED</p>
            <p className="onboarding__section-body">
              Your workspace context is injected at the start of every session. Preview
              exactly what gets sent — content and token count — and control what's
              included in Settings → Session Context.
            </p>
            <p className="onboarding__section-label" style={{ marginTop: 10 }}>WHAT CAN ANALYZE YOUR INPUTS</p>
            <p className="onboarding__section-body">
              Claude Code and Codex routinely check your connected integrations —
              Granola for new meeting notes, Slack for channel activity — and update
              your context automatically.
            </p>
          </div>

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
                onClick={() => setStep("inputs")}
              >
                Continue anyway
              </button>

            )}
          </div>
        </div>
      )}

      {/* ── Step 4: Inputs ──────────────────────────────────────────────────── */}
      {step === "inputs" && (
        <div className="onboarding__body">
          <div className="onboarding__nav">
            <button className="onboarding__back" onClick={handleBack}>← Back</button>
            <p className="onboarding__step-indicator">Step {stepNum} of {TOTAL_STEPS}</p>
          </div>
          <h1 className="onboarding__title">Connect your input sources</h1>
          <p className="onboarding__desc">
            Draft routinely checks these sources for new content and updates your
            workspace context automatically.
          </p>

          <div className="onboarding__tool-list">
            {/* Granola */}
            <div className="onboarding__input-row">
              <span className="onboarding__tool-text">
                <span className="onboarding__tool-name">Granola</span>
                <span className="onboarding__tool-desc">Meeting notes — routinely checked for new content</span>
                <span className="onboarding__input-cmd-label">Run in Claude Code or Codex:</span>
                <CopyableCmd cmd="/draft-connect granola" />
              </span>
            </div>

            {/* Slack */}
            <div className="onboarding__input-row">
              <span className="onboarding__tool-text">
                <span className="onboarding__tool-name">Slack</span>
                <span className="onboarding__tool-desc">Channel activity — routinely checked for team updates, decisions, and shifts</span>
                <span className="onboarding__input-cmd-label">Run in Claude Code or Codex:</span>
                <CopyableCmd cmd="/draft-connect slack" />
              </span>
            </div>

            {/* GitHub */}
            <div className="onboarding__input-row onboarding__input-row--with-action">
              <span className="onboarding__tool-text">
                <span className="onboarding__tool-name">GitHub</span>
                <span className="onboarding__tool-desc">Your repos and PRs — routinely checked for engineering context</span>
              </span>
              <span className="onboarding__input-action">
                {githubConnected ? (
                  <span className="onboarding__input-connected">Connected ✓</span>
                ) : (
                  <button
                    className="app-row__connect"
                    onClick={() => void handleConnectGitHub()}
                    disabled={connectingGitHub}
                  >
                    {connectingGitHub ? "Waiting…" : "Connect"}
                  </button>
                )}
              </span>
            </div>
          </div>

          {githubError && <p className="onboarding__error">{githubError}</p>}

          <p className="onboarding__hint">
            You can skip for now and connect these later in Settings → Input Sources.
          </p>

          <button
            className="empty-state__cta onboarding__cta"
            style={{ marginTop: 20 }}
            onClick={() => setStep("collab")}
          >
            Continue
          </button>
        </div>
      )}

      {/* ── Step 5: Collaboration ───────────────────────────────────────────── */}
      {step === "collab" && (
        <div className="onboarding__body">
          <div className="onboarding__nav">
            <button className="onboarding__back" onClick={handleBack}>← Back</button>
            <p className="onboarding__step-indicator">Step {stepNum} of {TOTAL_STEPS}</p>
          </div>
          <h1 className="onboarding__title">Working with a team?</h1>
          <p className="onboarding__desc">
            Draft can share your context layer across your whole team. Everyone's
            sessions start with the same shared product knowledge, kept fresh as
            things change.
          </p>

          <div className="onboarding__collab-section">
            <p className="onboarding__section-label">SET UP IN CLAUDE CODE OR CODEX</p>
            <p className="onboarding__section-body">
              Run{" "}
              <code className="onboarding__code">/draft-setup-collab</code>
              {" "}— it walks you through connecting a private GitHub repo as a
              shared context layer in about 5 minutes. One person sets it up;
              teammates connect with a URL.
            </p>
            <p className="onboarding__section-body" style={{ marginTop: 6, color: "var(--color-text-tertiary)", fontSize: "var(--font-size-micro)" }}>
              Note: this uses a dedicated GitHub repo as a sync layer — separate from
              connecting your GitHub account as an input source in step 4.
            </p>
          </div>

          <button
            className="empty-state__cta onboarding__cta"
            style={{ marginTop: 20 }}
            onClick={() => setStep("consent")}
          >
            Continue
          </button>
        </div>
      )}

      {/* ── Step 6: Consent ─────────────────────────────────────────────────── */}
      {step === "consent" && (
        <div className="onboarding__body">
          <div className="onboarding__nav">
            <button className="onboarding__back" onClick={handleBack}>← Back</button>
            <p className="onboarding__step-indicator">Step {stepNum} of {TOTAL_STEPS}</p>
          </div>
          <h1 className="onboarding__title">Help us improve Draft?</h1>
          <p className="onboarding__desc">
            Share anonymous usage data so we can see where people get stuck and
            what's working.
          </p>

          <div className="onboarding__consent-details">
            <p className="onboarding__section-label" style={{ marginBottom: 8 }}>WE NEVER COLLECT</p>
            <div className="onboarding__consent-row">
              <span className="onboarding__consent-check--no">✗</span>
              <span>Prompts or conversations</span>
            </div>
            <div className="onboarding__consent-row">
              <span className="onboarding__consent-check--no">✗</span>
              <span>Content of your context files</span>
            </div>
            <div className="onboarding__consent-row">
              <span className="onboarding__consent-check--no">✗</span>
              <span>File names or paths</span>
            </div>
          </div>

          <p className="onboarding__hint" style={{ marginTop: 12 }}>
            We collect navigation patterns and error codes only. Data is aggregated
            and never tied to your identity.
          </p>

          <div className="onboarding__actions" style={{ marginTop: 20 }}>
            <button
              className="empty-state__cta onboarding__cta"
              onClick={() => void handleConsent(true)}
              disabled={consentSaving}
            >
              Yes, help improve Draft
            </button>
            <button
              className="onboarding__skip"
              onClick={() => void handleConsent(false)}
              disabled={consentSaving}
            >
              No thanks
            </button>
          </div>
        </div>
      )}

      {/* ── Step 7: Done ────────────────────────────────────────────────────── */}
      {step === "complete" && (
        <div className="onboarding__body">
          <div className="onboarding__nav">
            <button className="onboarding__back" onClick={handleBack}>← Back</button>
            <p className="onboarding__step-indicator">Step {stepNum} of {TOTAL_STEPS}</p>
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
      )}

    </div>
  );
}

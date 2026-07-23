// JoinTeamStep.tsx — native GitHub OAuth join-team flow (replaces CollabStep
// on the "join" onboarding path)
//
// State machine:
//   idle (repo URL input, or a "Finish joining?" resume prompt if
//     checkGitHubJoinStatus reports pending:true)
//   -> submit -> startGitHubJoin (returns almost instantly)
//   -> subscribe to githubOAuthProgress
//   -> "awaiting_user": show the device code + auto-open the verification URL
//   -> "verifying_access" / (post-code) "complete": spinner + label
//   -> "complete" -> onNext()
//   -> "error": per-errorCode copy; retry re-runs verify/resume only when the
//      progress event's `resumable` flag says a token/pending_join already
//      exists, otherwise goes back to idle for a fresh device code

import { useEffect, useState } from "react";
import { rpc, events } from "../../../rpc";
import { useAnalytics } from "../../../analytics/AnalyticsContext";
import { CopyableCmd, HeadlessProgress } from "./shared";

interface JoinTeamStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

type Phase = "idle" | "awaiting_user" | "verifying_access" | "complete" | "error";

type TrackedErrorCode = "no_access" | "expired" | "denied" | "network" | "rate_limited" | "device_flow_disabled" | "unknown";
const TRACKED_ERROR_CODES = new Set<TrackedErrorCode>(["no_access", "expired", "denied", "network", "rate_limited", "device_flow_disabled"]);
function asTrackedErrorCode(code: string | undefined): TrackedErrorCode {
  return code && TRACKED_ERROR_CODES.has(code as TrackedErrorCode) ? (code as TrackedErrorCode) : "unknown";
}

const ERROR_COPY: Record<string, string> = {
  no_access: "No access yet — ask your team to add you to the GitHub org, then try again.",
  token_revoked: "GitHub access was revoked. Start over to reconnect.",
  expired: "This code expired. Start over to get a new one.",
  denied: "Sign-in was cancelled.",
  device_flow_disabled: "Your GitHub organization has disabled device sign-in for this app.",
  network: "Network error during sign-in. Try again.",
  rate_limited: "GitHub rate-limited this request. Try again shortly.",
};

export function JoinTeamStep({ stepNum, totalSteps, onBack, onNext }: JoinTeamStepProps) {
  const { track } = useAnalytics();
  const [repoUrl, setRepoUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | undefined>(undefined);
  // Whether a retry should call resumeGitHubJoin (a token/pending_join
  // already exists) vs. go back to idle for a fresh device code. Driven by
  // the progress event's own resumable flag, not a fixed errorCode list —
  // network/unknown errors can happen either before or after pending_join
  // is written, so the errorCode alone can't tell them apart.
  const [resumable, setResumable] = useState(false);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [checkingResume, setCheckingResume] = useState(true);
  const [resumePrompt, setResumePrompt] = useState(false);

  useEffect(() => {
    rpc.request.checkGitHubJoinStatus()
      .then((status) => setResumePrompt(status.pending && !status.connected))
      .catch(() => {})
      .finally(() => setCheckingResume(false));
  }, []);

  useEffect(() => events.on("githubOAuthProgress", (progress) => {
    setPhase(progress.phase);
    setLabel(progress.label);
    if (progress.phase === "awaiting_user") {
      setUserCode(progress.userCode ?? null);
      setVerificationUri(progress.verificationUri ?? null);
      if (progress.verificationUri) {
        track("github_join_code_displayed", {});
        void rpc.send.openUrl({ url: progress.verificationUri });
      }
    }
    if (progress.phase === "error") {
      setError(progress.label);
      setErrorCode(progress.errorCode);
      setResumable(progress.resumable ?? false);
      track("github_join_failed", { error_code: asTrackedErrorCode(progress.errorCode) });
    }
    if (progress.phase === "complete") {
      track("github_join_succeeded", {});
      setTimeout(onNext, 600);
    }
  }), [track, onNext]);

  // Cancel on unmount or Back — a half-finished device flow must never keep
  // polling GitHub after the user has navigated away.
  useEffect(() => {
    return () => { void rpc.request.cancelGitHubJoin(); };
  }, []);

  async function handleSubmit() {
    const trimmed = repoUrl.trim();
    if (!trimmed) return;
    setError(null);
    setErrorCode(undefined);
    setResumable(false);
    setResumePrompt(false);
    track("github_join_started", {});
    const result = await rpc.request.startGitHubJoin({ repoUrl: trimmed });
    if (!result.ok) {
      setPhase("error");
      setError(result.error ?? "Couldn't start GitHub sign-in.");
      setResumable(false); // the flow never started — nothing to resume
    }
  }

  async function handleResume() {
    setResumePrompt(false);
    setError(null);
    setErrorCode(undefined);
    track("github_join_resumed", {});
    const result = await rpc.request.resumeGitHubJoin();
    if (!result.ok) {
      setPhase("error");
      setError(result.error ?? "Couldn't resume the join.");
    }
  }

  async function handleRetry() {
    setError(null);
    setErrorCode(undefined);
    if (!resumable) {
      // Nothing to resume yet (failed before a token/pending_join existed,
      // e.g. an invalid URL or a network blip on the very first device-code
      // request) — go back to idle for a fresh attempt/device code.
      setPhase("idle");
      setUserCode(null);
      setVerificationUri(null);
      return;
    }
    // pending_join exists — re-verify access and finish the join, no new device code.
    await handleResume();
  }

  function handleBack() {
    void rpc.request.cancelGitHubJoin();
    onBack();
  }

  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={handleBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Join your team's workspace</h1>
      <p className="onboarding__desc">
        Paste the team repo URL a teammate shared with you. You'll sign in
        with GitHub in your browser — nothing else to install.
      </p>

      {!checkingResume && resumePrompt && phase === "idle" && (
        <div className="onboarding__collab-section">
          <p className="onboarding__section-body">
            You started joining a team earlier but didn't finish. Pick up where you left off?
          </p>
          <button className="empty-state__cta onboarding__cta" style={{ marginTop: 10 }} onClick={handleResume}>
            Finish joining
          </button>
        </div>
      )}

      {phase === "idle" && !resumePrompt && (
        <>
          <div className="setup-incomplete__create-form">
            <input
              className="setup-incomplete__create-input"
              type="text"
              placeholder="https://github.com/your-team/context"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              autoFocus
            />
            <button
              className="empty-state__cta onboarding__cta"
              onClick={handleSubmit}
              disabled={!repoUrl.trim()}
            >
              Continue
            </button>
          </div>
          <p className="onboarding__section-body" style={{ marginTop: 10, color: "var(--color-text-tertiary)", fontSize: "var(--font-size-micro)" }}>
            This grants Draft read access to your GitHub repositories
            generally — GitHub doesn't support narrower per-repo permission
            for an individual collaborator. Revoke access anytime at
            github.com/settings/connections/applications.
          </p>
        </>
      )}

      {phase === "awaiting_user" && userCode && (
        <div className="onboarding__collab-section">
          <p className="onboarding__section-label">ENTER THIS CODE ON GITHUB</p>
          <CopyableCmd cmd={userCode} />
          <p className="onboarding__section-body" style={{ marginTop: 10 }}>
            We opened {verificationUri ?? "GitHub"} in your browser.
          </p>
          <p className="onboarding__section-body" style={{ marginTop: 12 }}>
            If it didn't open,{" "}
            {verificationUri
              ? <button className="onboarding__cmd" onClick={() => void rpc.send.openUrl({ url: verificationUri })}>open it manually</button>
              : "visit github.com/login/device"}
          </p>
          <p className="onboarding__section-body" style={{ marginTop: 6, color: "var(--color-text-tertiary)", fontSize: "var(--font-size-micro)" }}>
            Don't have a GitHub account?{" "}
            <button className="onboarding__cmd" onClick={() => void rpc.send.openUrl({ url: "https://github.com/join" })}>
              Create one
            </button>
          </p>
        </div>
      )}

      {(phase === "verifying_access" || (phase === "awaiting_user" && !userCode)) && (
        <HeadlessProgress label={label || "Checking repository access…"} />
      )}

      {phase === "complete" && <HeadlessProgress label="You're all set." />}

      {phase === "error" && error && (
        <div className="onboarding__collab-section">
          <p className="onboarding__error">{ERROR_COPY[errorCode ?? ""] ?? error}</p>
          <button className="empty-state__cta onboarding__cta" style={{ marginTop: 10 }} onClick={handleRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

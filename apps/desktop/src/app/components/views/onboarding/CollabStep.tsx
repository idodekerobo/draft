// CollabStep.tsx — invite a teammate to this org/team's workspace

import { useEffect, useState } from "react";
import { rpc } from "../../../rpc";

interface CollabStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

export function CollabStep({ stepNum, totalSteps, onBack, onNext }: CollabStepProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    rpc.request.getInviteLink()
      .then((result) => {
        if (!live) return;
        if (result.ok && result.url) setUrl(result.url);
        else setError(result.error ?? "Could not load your invite link.");
      })
      .catch(() => { if (live) setError("Could not load your invite link."); });
    return () => { live = false; };
  }, []);

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return (
    <div className="onboarding__body">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Working with a team?</h1>
      <p className="onboarding__desc">
        Share this link with teammates — they sign in and land in this same workspace.
        It works for anyone on your team, any number of times.
      </p>

      <div className="onboarding__connect-panel">
        {error && <span className="onboarding__validation">{error}</span>}
        {url && (
          <>
            <label className="onboarding__panel-label">Invite link</label>
            <div className="onboarding__copy-row">
              <code>{url}</code>
              <button type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
            </div>
          </>
        )}
        {!url && !error && <span className="onboarding__desc">Loading your invite link…</span>}
      </div>

      <button
        className="empty-state__cta onboarding__cta"
        style={{ marginTop: 20 }}
        onClick={onNext}
      >
        Continue
      </button>
    </div>
  );
}

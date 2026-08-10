import { useEffect, useState } from "react";
import { rpc } from "../../../rpc";
import { useUserIdentity } from "../../../identity/UserIdentityContext";
import { DEFAULT_SETUP_DIMENSIONS, DimensionPicker, toDimensionHints } from "./shared";

interface HeadlessSetupStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

type RunPhase = "idle" | "uploadingAndStarting" | "starting";

export function HeadlessSetupStep({ stepNum, totalSteps, onBack, onNext }: HeadlessSetupStepProps) {
  const identity = useUserIdentity();
  const [hasContext, setHasContext] = useState<boolean | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<string[]>(DEFAULT_SETUP_DIMENSIONS);

  const ready = identity.hydrated && identity.signedIn && identity.workspaceId !== null;

  useEffect(() => {
    if (!ready) return;
    let live = true;
    rpc.request.getWorkspaceContextStatus()
      .then((status) => { if (live) setHasContext(status.hasContext); })
      .catch(() => { if (live) setHasContext(false); });
    return () => { live = false; };
  }, [ready]);

  useEffect(() => {
    if (hasContext === true) onNext();
  }, [hasContext]);

  async function pickFolder() {
    const picked = await rpc.request.selectUploadFolder();
    if (picked.folderPath) setFolderPath(picked.folderPath);
  }

  // when a folder is picked, upload+trigger happen server-side
  async function startSynthesis() {
    setError(null);
    setMessage(null);
    setPhase(folderPath ? "uploadingAndStarting" : "starting");
    try {
      const result = await rpc.request.bootstrapWorkspaceContext({
        folderPath: folderPath ?? undefined,
        dimensions: toDimensionHints(dimensions),
      });
      if (!result.ok) {
        setError(result.error ?? "Could not start the workspace synthesis run.");
        return;
      }
      if (result.runId) {
        setMessage("Your workspace is being set up in the cloud. This can take a few minutes.");
        setTimeout(onNext, 800);
        return;
      }
      if (result.reason === "no_ready_items") {
        setError(
          folderPath
            ? "No eligible files in that folder — choose a different one, or skip and set this up later."
            : "Nothing to synthesize yet — choose a folder above or connect a source, then try again. Or skip and set this up later.",
        );
        return;
      }
      setError(result.synthesisError ? `Uploaded, but could not start synthesis (${result.synthesisError}).` : "Could not start the workspace synthesis run.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the workspace synthesis run.");
    } finally {
      setPhase("idle");
    }
  }

  if (hasContext === null) {
    return (
      <div className="onboarding__body onboarding__body--wide">
        <div className="onboarding__nav">
          <button className="onboarding__back" onClick={onBack}>← Back</button>
          <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
        </div>
        <h1 className="onboarding__title">Set up your context</h1>
        <p className="onboarding__desc">Checking your workspace…</p>
      </div>
    );
  }

  const busy = phase !== "idle";
  const buttonLabel = phase === "uploadingAndStarting" ? "Uploading folder and starting synthesis…" : phase === "starting" ? "Starting synthesis…" : "Start synthesis";

  return (
    <div className="onboarding__body onboarding__body--wide">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Set up your context</h1>
      <p className="onboarding__desc">
        Draft bootstraps your workspace context in the cloud. Optionally add a local folder
        of docs to seed it — otherwise it starts empty and grows as your connected sources come in.
      </p>

      <div className="onboarding__connect-panel">
        <span className="onboarding__panel-label">Local context (optional)</span>
        <span className="onboarding__panel-help">
          The cloud sandbox can't read your disk directly — pick a folder and Draft uploads its
          file contents as source material when you start synthesis below.
        </span>
        <button type="button" className="onboarding__panel-link onboarding__panel-action" onClick={() => void pickFolder()} disabled={busy}>
          {folderPath ?? "Choose a folder…"}
        </button>
      </div>

      <DimensionPicker dimensions={dimensions} onChange={setDimensions} />

      <div className="onboarding__connect-panel" style={{ marginTop: 12 }}>
        <span className="onboarding__panel-label">Start the first synthesis run</span>
        <button type="button" className="onboarding__connect onboarding__panel-action" onClick={() => void startSynthesis()} disabled={busy}>
          {buttonLabel}
        </button>
        {message && <span className="onboarding__hint">{message}</span>}
        {error && <span className="onboarding__validation">{error}</span>}
      </div>

      <div className="onboarding__actions" style={{ marginTop: 20 }}>
        <button className="onboarding__skip" onClick={onNext}>Skip</button>
      </div>
    </div>
  );
}

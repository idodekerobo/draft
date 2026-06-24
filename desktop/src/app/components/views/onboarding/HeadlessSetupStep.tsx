import { useEffect, useState } from "react";
import type { ContextFileEntry, HeadlessSetupPhase } from "../../../../rpc/schema";
import { events, rpc } from "../../../rpc";
import { CopyableCmd } from "./shared";

interface HeadlessSetupStepProps {
  stepNum: number;
  totalSteps: number;
  onBack: () => void;
  onNext: () => void;
}

type Runner = "claude" | "codex";

export function HeadlessSetupStep({ stepNum, totalSteps, onBack, onNext }: HeadlessSetupStepProps) {
  const [phase, setPhase] = useState<HeadlessSetupPhase | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const [files, setFiles] = useState<ContextFileEntry[]>([]);
  const [lastMode, setLastMode] = useState<"scratch" | "import">("scratch");
  const [showDetail, setShowDetail] = useState(false);

  const [availableRunners, setAvailableRunners] = useState<Runner[]>([]);
  const [selectedRunner, setSelectedRunner] = useState<Runner>("claude");
  const [runnersLoaded, setRunnersLoaded] = useState(false);

  useEffect(() => {
    void rpc.request.getAvailableRunners().then((result) => {
      const installed = result.runners.filter((r) => r.installed).map((r) => r.name);
      setAvailableRunners(installed);
      if (installed.length > 0 && !installed.includes(selectedRunner)) {
        setSelectedRunner(installed[0]);
      }
      setRunnersLoaded(true);
    }).catch(() => setRunnersLoaded(true));
  }, []);

  useEffect(() => events.on("headlessProgress", (progress) => {
    setPhase(progress.phase);
    setLabel(progress.label);
    if (progress.phase === "error") {
      setError(progress.label);
      setErrorDetail(progress.error ?? null);
    }
    if (progress.phase === "complete") void rpc.request.getContextFiles().then(setFiles).catch(() => {});
  }), []);

  async function selectFolder() {
    const result = await rpc.request.selectSetupFolder();
    setFolderPath(result.folderPath);
  }

  async function start(mode: "scratch" | "import") {
    setLastMode(mode);
    setError(null);
    setErrorDetail(null);
    setShowDetail(false);
    setFiles([]);
    const result = await rpc.request.runHeadlessSetup({
      mode,
      runner: selectedRunner,
      ...(mode === "import" ? { folderPath: folderPath ?? undefined } : {}),
    });
    if (!result.ok) {
      setPhase("error");
      setError(result.error ?? "Could not start context setup.");
    }
  }

  const running = phase === "starting" || phase === "running" || phase === "writing";
  const noRunnersInstalled = runnersLoaded && availableRunners.length === 0;

  return (
    <div className="onboarding__body onboarding__body--wide">
      <div className="onboarding__nav">
        <button className="onboarding__back" onClick={onBack} disabled={running}>← Back</button>
        <p className="onboarding__step-indicator">Step {stepNum} of {totalSteps}</p>
      </div>
      <h1 className="onboarding__title">Set up your context</h1>
      <p className="onboarding__desc">Draft can create a starting context workspace without sending you to a terminal.</p>

      {noRunnersInstalled && (
        <div className="onboarding__manual-fallback">
          <p className="onboarding__error">No CLI runner found. Install Claude Code or Codex, then open your terminal and run:</p>
          <CopyableCmd cmd="/draft-setup" />
          <button className="onboarding__skip" onClick={onNext}>Skip for now</button>
        </div>
      )}

      {!phase && !noRunnersInstalled && <>
        {runnersLoaded && availableRunners.length > 1 && (
          <div className="onboarding__runner-picker">
            <span className="onboarding__runner-label">Run with</span>
            <div className="onboarding__mode-picker">
              {availableRunners.map((r) => (
                <button key={r} className={selectedRunner === r ? "onboarding__mode--selected" : ""} onClick={() => setSelectedRunner(r)}>
                  {r === "claude" ? "Claude Code" : "Codex"}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="onboarding__setup-options">
          <button className="onboarding__setup-option" onClick={() => void start("scratch")}>
            <strong>Start from scratch</strong><span>Create a practical first version from your installed tools and connected sources.</span>
          </button>
          <button className="onboarding__setup-option" onClick={() => void selectFolder()}>
            <strong>Import a local folder</strong><span>{folderPath ?? "Choose a folder so Draft can use its file list as context."}</span>
          </button>
          {folderPath && <button className="empty-state__cta onboarding__cta" onClick={() => void start("import")}>Set up from this folder</button>}
        </div>
      </>}

      {running && <div className="onboarding__headless-progress" aria-live="polite"><span className="onboarding__spinner" /><span>{label}</span></div>}

      {error && !running && (
        <div className="onboarding__error-block">
          <p className="onboarding__error">{error}</p>
          {errorDetail && (
            <button className="onboarding__error-toggle" onClick={() => setShowDetail(!showDetail)}>
              {showDetail ? "Hide details" : "Show details"}
            </button>
          )}
          {showDetail && errorDetail && (
            <pre className="onboarding__error-detail">{errorDetail}</pre>
          )}
        </div>
      )}

      {phase === "complete" && <>
        <p className="onboarding__headless-success">{label}</p>
        {files.length > 0 && <p className="onboarding__hint">Created or updated: {files.slice(0, 4).map((file) => file.label).join(", ")}{files.length > 4 ? ", and more" : ""}.</p>}
        <button className="empty-state__cta onboarding__cta" style={{ marginTop: 20 }} onClick={onNext}>Looks good</button>
      </>}

      {(error || !phase) && !noRunnersInstalled && <div className="onboarding__manual-fallback">
        {error && <button className="empty-state__cta onboarding__cta" onClick={() => void start(lastMode)}>Try again</button>}
        <p>Prefer to do this manually? Open {selectedRunner === "claude" ? "Claude Code" : "Codex"} and run:</p>
        <CopyableCmd cmd="/draft-setup" />
        <button className="onboarding__skip" onClick={onNext}>Skip for now</button>
      </div>}
    </div>
  );
}

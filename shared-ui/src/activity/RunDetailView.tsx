"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BackButton } from "../controls/BackButton";
import { useDraftApi } from "../query/api";
import { runDetailQueryOptions, runTranscriptQueryOptions } from "../query/options";
import type { RunDetail, RunStepDetail, RunUsageSummary, StepRunDetail, StepStatus } from "./run-detail-types";

const IN_PROGRESS = new Set(["queued", "preparing", "running", "validating", "committing"]);

/** The synthesis steps have names and purposes of their own. A custom step is shown by its name. */
const KNOWN_STEPS: Record<string, { label: string; purpose: string }> = {
  capture: { label: "Capture", purpose: "Reads the new sources and notes what matters." },
  reconcile: { label: "Reconcile", purpose: "Checks each document against the new evidence and fixes what is out of date." },
  organize: { label: "Organize", purpose: "Writes the notes into memory and records what could not be settled." },
};

export function stepLabel(key: string): string {
  const known = KNOWN_STEPS[key]?.label;
  if (known) return known;
  const words = key.replace(/_/g, " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Step";
}

const STEP_STATUS: Record<StepStatus, { word: string; dot: string }> = {
  done: { word: "Done", dot: "connected" },
  running: { word: "Running", dot: "pending" },
  waiting: { word: "Waiting", dot: "idle" },
  failed: { word: "Failed", dot: "error" },
  skipped: { word: "Skipped, nothing to do", dot: "idle" },
  not_run: { word: "Not run", dot: "idle" },
};

const RUN_STATUS_WORD: Record<string, string> = { succeeded: "Done", failed: "Failed", stale: "Failed", cancelled: "Cancelled", queued: "Waiting" };

/** Plain words for why a step run stopped. A code Draft does not know is shown as it is. */
export function describeFailure(code: string | null): string {
  switch (code) {
    case null: return "It did not finish.";
    case "step_run_stale": return "It did not report back in time.";
    case "step_launch_failed": return "It could not start.";
    case "claude_exit": case "codex_exit": return "The agent stopped before it finished.";
    case "claude_error": case "codex_error": return "The agent reported an error.";
    case "timeout": return "It took too long and was stopped.";
    case "incomplete_result": return "The agent stopped without an answer.";
    case "step_result_invalid": return "Its answer was not in the right form.";
    default: return `It failed (${code}).`;
  }
}

const formatCount = (value: number) => value.toLocaleString();

export function describeUsage(usage: RunUsageSummary | null): string | null {
  if (!usage) return null;
  const tokens = `${formatCount(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)} tokens in, ${formatCount(usage.outputTokens)} out`;
  return usage.costUsd !== null ? `${tokens}, about $${usage.costUsd.toFixed(2)}` : tokens;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function formatDuration(start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const seconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 90) return `${Math.round(seconds)}s`;
  return `${Math.round(seconds / 60)} min`;
}

function Transcript({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const api = useDraftApi();
  const transcript = useQuery(runTranscriptQueryOptions(api, workspaceId, runId));
  if (transcript.isPending) return <p className="ui-muted" role="status">Loading what it did…</p>;
  if (transcript.isError) return <p className="ui-error" role="alert">Could not load what it did. <button type="button" className="ui-link" onClick={() => void transcript.refetch()}>Try again</button></p>;
  if (transcript.data.lines.length === 0) return <p className="ui-muted">No transcript was saved for this run.</p>;
  return (
    <>
      <pre className="ui-prompt ui-run__transcript" tabIndex={0} aria-label="Transcript">{transcript.data.lines.join("\n")}</pre>
      {transcript.data.truncated && <p className="ui-muted">Only the first part is shown.</p>}
    </>
  );
}

function StepRun({ run, workspaceId }: { run: StepRunDetail; workspaceId: string }) {
  const [showTranscript, setShowTranscript] = useState(false);
  const failed = run.status === "failed" || run.status === "stale";
  const meta = [
    RUN_STATUS_WORD[run.status] ?? "Running",
    run.attempt > 1 ? `Attempt ${run.attempt}` : null,
    formatDuration(run.startedAt, run.completedAt),
    describeUsage(run.usage),
  ].filter(Boolean).join(", ");
  return (
    <li className="ui-run-step__run">
      <p className="ui-run-step__run-line"><span className="ui-run-step__run-label">{run.label || "Run"}</span> <span className="ui-muted">{meta}</span></p>
      {failed && <p className="ui-run-step__run-failure">{describeFailure(run.failureCode)}</p>}
      {!failed && run.summary && <p className="ui-muted">{run.summary}</p>}
      {run.documentsChanged.length > 0 && <p className="ui-muted">Changed {run.documentsChanged.join(", ")}</p>}
      {run.hasTranscript && (
        <>
          <button type="button" className="ui-link" aria-expanded={showTranscript} onClick={() => setShowTranscript(!showTranscript)}>{showTranscript ? "Hide what it did" : "Show what it did"}</button>
          {showTranscript && <Transcript workspaceId={workspaceId} runId={run.id} />}
        </>
      )}
    </li>
  );
}

function Step({ step, index, workspaceId }: { step: RunStepDetail; index: number; workspaceId: string }) {
  const [open, setOpen] = useState(step.status === "failed");
  const panelId = useId();
  const known = KNOWN_STEPS[step.key];
  const status = STEP_STATUS[step.status];
  const failedRuns = step.runs.filter((run) => run.status === "failed" || run.status === "stale").length;
  return (
    <li className={`ui-run-step${step.status === "failed" ? " ui-run-step--failed" : ""}`}>
      <div className="ui-run-step__head">
        <span className="ui-run-step__num" aria-hidden="true">{index + 1}</span>
        <div className="ui-run-step__text">
          <p className="ui-run-step__name">{stepLabel(step.key)}</p>
          {known && <p className="ui-run-step__purpose">{known.purpose}</p>}
        </div>
        <span className="ui-run-step__status"><span className={`ui-dot ui-dot--${status.dot}`} aria-hidden="true" />{status.word}</span>
      </div>
      {step.runs.length > 0 && (
        <>
          <button type="button" className="ui-link ui-run-step__toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"} {step.runs.length} {step.runs.length === 1 ? "run" : "runs"}{failedRuns > 0 ? `, ${failedRuns} failed` : ""}
          </button>
          {open && <ul id={panelId} className="ui-run-step__runs">{step.runs.map((run) => <StepRun key={run.id} run={run} workspaceId={workspaceId} />)}</ul>}
        </>
      )}
    </li>
  );
}

function stateOf(detail: RunDetail): { word: string; dot: string } {
  if (IN_PROGRESS.has(detail.status)) return { word: "In progress", dot: "pending" };
  if (detail.status === "succeeded") return { word: "Completed", dot: "connected" };
  return { word: "Failed", dot: "error" };
}

/** Says where a failed run stopped, what finished before, and what that means for the documents. */
function FailureNotice({ detail }: { detail: RunDetail }) {
  const failed = detail.steps.find((step) => step.key === detail.failedStep);
  const finished = detail.steps.filter((step) => step.status === "done" || step.status === "skipped").length;
  return (
    <div className="ui-run__notice" role="alert">
      <p className="ui-run__notice-title">{failed ? `Stopped at the ${stepLabel(failed.key).toLowerCase()} step` : "This run did not finish"}</p>
      <p>
        {detail.steps.length > 0 && `${finished} of ${detail.steps.length} steps finished. `}
        {detail.documentsChanged.length > 0 ? `Documents already updated stay updated: ${detail.documentsChanged.join(", ")}.` : "No documents were changed."}
        {detail.kind === "synthesis" && " Sources that were not read stay pending for the next run."}
      </p>
    </div>
  );
}

/** One run of a routine or of synthesis, with its steps. It opens from Activity, and Back returns there. */
export function RunDetailView({ workspaceId, runId, onBack }: { workspaceId: string; runId: string; onBack: () => void }) {
  const api = useDraftApi();
  const query = useQuery(runDetailQueryOptions(api, workspaceId, runId));
  const titleId = useId();

  const header = (title: string) => (
    <div className="ui-run__head">
      <BackButton onClick={onBack} label="Back to Activity" />
      <h2 id={titleId} className="ui-run__title">{title}</h2>
    </div>
  );

  if (query.isPending) return <section aria-labelledby={titleId}>{header("Run")}<p className="ui-muted" role="status">Loading this run…</p></section>;
  if (query.isError) {
    return (
      <section aria-labelledby={titleId}>
        {header("Run")}
        <p className="ui-error" role="alert">Could not load this run. <button type="button" className="ui-link" onClick={() => void query.refetch()}>Try again</button></p>
      </section>
    );
  }

  const detail = query.data;
  const state = stateOf(detail);
  const title = detail.routineTitle ?? (detail.kind === "synthesis" ? "Context update" : "Run");
  const meta = [state.word, detail.startedAt ? formatWhen(detail.startedAt) : null, formatDuration(detail.startedAt, detail.completedAt)].filter(Boolean).join(", ");
  const usage = describeUsage(detail.usage);

  return (
    <section aria-labelledby={titleId} className="ui-run">
      {header(title)}
      <p className="ui-run__status"><span className={`ui-dot ui-dot--${state.dot}`} aria-hidden="true" />{meta}</p>
      {detail.status === "failed" || detail.status === "stale" ? <FailureNotice detail={detail} /> : detail.summary && <p className="ui-muted">{detail.summary}</p>}
      {detail.steps.length === 0 ? (
        <p className="ui-muted">This run did not use steps.</p>
      ) : (
        <ol className="ui-run__steps" aria-label="Steps">
          {detail.steps.map((step, index) => <Step key={step.key} step={step} index={index} workspaceId={workspaceId} />)}
        </ol>
      )}
      <dl className="ui-run__totals">
        {usage && <><dt>Used</dt><dd>{usage}</dd></>}
        <dt>Documents changed</dt>
        <dd>{detail.documentsChanged.length > 0 ? detail.documentsChanged.join(", ") : IN_PROGRESS.has(detail.status) ? "None yet" : "None"}</dd>
      </dl>
    </section>
  );
}

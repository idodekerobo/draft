"use client";

import { useEffect, useState, type ReactNode } from "react";
import { contextExcerpt, type ContextFileEntry } from "../context/context-files";
import type { FlowStep, TrackFn } from "../analytics/events";
import type { ToolStatus } from "../integrations/registry";
import { CopyButton, CopyableCmd } from "./components";
import { FlowActions, FlowShell, type FlowDestination } from "./flow";

export function GiveSourceScreen({ toolList, hasSource, onImportFolder, onNext, onSkip, onBrowseAll }: {
  toolList: ReactNode;
  hasSource: boolean;
  /** Desktop only. */
  onImportFolder?: () => void;
  onNext: () => void;
  onSkip: () => void;
  onBrowseAll: () => void;
}) {
  return (
    <>
      <h1 className="ui-flow__title">Give Draft something to read</h1>
      <p className="ui-flow__subtitle">Connect one source to start. Your context stays empty until you connect a source.</p>
      {toolList}
      <div className="ui-flow__buttons ui-flow__browse">
        <button type="button" className="ui-link" onClick={onBrowseAll}>Browse all tools</button>
        {onImportFolder && <button type="button" className="ui-link" onClick={onImportFolder}>Import from a folder on this computer</button>}
      </div>
      <FlowActions
        primary={<button type="button" className="ui-btn ui-btn--primary" onClick={onNext} disabled={!hasSource}>Next</button>}
        secondary={<button type="button" className="ui-link" onClick={onSkip}>Skip</button>}
      />
    </>
  );
}

export interface ReadingSource {
  name: string;
  status: ToolStatus;
  /** For example "Reading 4 channels". */
  detail?: string;
}

/** Honest wait copy, no promise of a notification. No Skip. */
export function ReadingScreen({ sources, onOpenDraft }: {
  sources: ReadingSource[];
  onOpenDraft: () => void;
}) {
  return (
    <>
      <h1 className="ui-flow__title">Draft is reading</h1>
      <p className="ui-flow__subtitle">First context usually takes 10 to 30 minutes. Check back in about 30 minutes.</p>
      <div className="ui-progress-line" role="progressbar" aria-label="Reading your sources" />
      <ul className="ui-rows">
        {sources.map((source) => (
          <li key={source.name} className="ui-reading-row">
            <span>{source.name}</span>
            <span className="ui-reading-row__status" role="status">
              <span><span className={`ui-dot ui-dot--${source.status.state}`} aria-hidden="true" />{source.status.state === "connected" ? "Connected" : source.status.detail ?? "Not connected"}</span>
              {source.detail && <small>{source.detail}</small>}
            </span>
          </li>
        ))}
      </ul>
      <FlowActions
        primary={<button type="button" className="ui-btn ui-btn--primary" onClick={onOpenDraft}>Open Draft</button>}
        note="Context appears in the Context tab when it is ready."
      />
    </>
  );
}

export function FirstContextScreen({ entry, inviteUrl, agentPrompt, onOpenContext }: {
  entry: ContextFileEntry;
  inviteUrl: string | null;
  agentPrompt: string;
  onOpenContext: () => void;
}) {
  return (
    <>
      <h1 className="ui-flow__title">Your first context is ready</h1>
      <h2 className="ui-group-label">{entry.label}</h2>
      <p className="ui-flow__lede">{contextExcerpt(entry.content, 420)}</p>
      {inviteUrl && (
        <>
          <h2 className="ui-group-label">Invite a teammate</h2>
          <p className="ui-flow__subtitle">Anyone with this link joins your team and sees this context.</p>
          <CopyableCmd cmd={inviteUrl} />
        </>
      )}
      <h2 className="ui-group-label">Connect your AI agent</h2>
      <p className="ui-flow__subtitle">Tell your agent to install the Draft CLI, then run <code>draft add &lt;agent&gt;</code>. Copy this prompt into it.</p>
      <CopyButton text={agentPrompt} label="Copy prompt" />
      <FlowActions primary={<button type="button" className="ui-btn ui-btn--primary" onClick={onOpenContext}>Open context</button>} />
    </>
  );
}

/** First user: Give Draft something to read, Draft is reading, then First context appears. */
export function FirstUserFlow({ toolList, hasSource, readingSources, entries, inviteUrl, agentPrompt, onImportFolder, onReadingChange, track, onFinish, error }: {
  toolList: ReactNode;
  hasSource: boolean;
  readingSources: ReadingSource[];
  entries: ContextFileEntry[];
  inviteUrl: string | null;
  agentPrompt: string;
  onImportFolder?: () => void;
  /** Lets the host poll only while "Draft is reading" is shown. */
  onReadingChange?: (reading: boolean) => void;
  track: TrackFn;
  onFinish: (destination: FlowDestination) => void;
  error?: string | null;
}) {
  const [step, setStep] = useState<FlowStep>("give_source");
  const first = entries.find((entry) => entry.kind === "dim") ?? entries[0];
  const shown: FlowStep = step === "reading" && first ? "first_context" : step;

  useEffect(() => { track("onboarding_step_viewed", { step: shown }); }, [shown]);
  useEffect(() => { onReadingChange?.(shown === "reading"); }, [shown]);

  function finish(destination: FlowDestination, outcome: "completed" | "skipped") {
    track(outcome === "completed" ? "onboarding_completed" : "onboarding_skipped", { step: shown });
    onFinish(destination);
  }

  return (
    <FlowShell>
      {error && <p className="ui-error" role="alert">{error}</p>}
      {shown === "give_source" && (
        <GiveSourceScreen
          toolList={toolList}
          hasSource={hasSource}
          onImportFolder={onImportFolder}
          onNext={() => setStep("reading")}
          onSkip={() => finish("connections", "skipped")}
          onBrowseAll={() => finish("connections", "completed")}
        />
      )}
      {shown === "reading" && (
        <ReadingScreen sources={readingSources} onOpenDraft={() => finish("context", "completed")} />
      )}
      {shown === "first_context" && first && (
        <FirstContextScreen entry={first} inviteUrl={inviteUrl} agentPrompt={agentPrompt} onOpenContext={() => finish("context", "completed")} />
      )}
    </FlowShell>
  );
}

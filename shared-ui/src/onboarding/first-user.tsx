"use client";

import { useEffect, useState, type ReactNode } from "react";
import { contextExcerpt, type ContextFileEntry } from "../context/context-files";
import type { FlowStep, TrackFn } from "../analytics/events";
import type { ToolStatus } from "../integrations/registry";
import { CopyButton, CopyableCmd } from "./components";
import { FlowActions, FlowShell, type FlowDestination } from "./flow";

export function GiveSourceScreen({ toolList, hasSource, onImportFolder, footer, onNext, onSkip }: {
  toolList: ReactNode;
  hasSource: boolean;
  /** Desktop only. */
  onImportFolder?: () => void;
  /** Shown under the tool list, for example the web app's desktop download card. */
  footer?: ReactNode;
  onNext: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <h1 className="ui-flow__title">Give Draft something to read</h1>
      <p className="ui-flow__subtitle">Connect one source to start. Your context stays empty until you connect a source.</p>
      {toolList}
      {onImportFolder && (
        <div className="ui-flow__buttons ui-flow__browse">
          <button type="button" className="ui-link" onClick={onImportFolder}>Import from a folder on this computer</button>
        </div>
      )}
      {footer}
      <FlowActions
        primary={<button type="button" className="ui-btn ui-btn--primary" onClick={onNext} disabled={!hasSource}>Next</button>}
        secondary={<button type="button" className="ui-link" onClick={onSkip}>Skip</button>}
      />
    </>
  );
}

/** After Skip: nothing to read yet, but the invite link and any extras still belong at the end of setup. */
export function ReadyScreen({ inviteUrl, onInviteCopied, extra, onOpenDraft, onConnectSource }: {
  inviteUrl?: string | null;
  onInviteCopied?: () => void;
  extra?: ReactNode;
  onOpenDraft: () => void;
  onConnectSource: () => void;
}) {
  return (
    <>
      <h1 className="ui-flow__title">You&apos;re set up</h1>
      <p className="ui-flow__subtitle">Draft has nothing to read yet, so your context is empty. Connect a source any time from Connections.</p>
      {inviteUrl && (
        <>
          <h2 className="ui-group-label">Invite a teammate</h2>
          <p className="ui-flow__subtitle">Anyone with this link joins your team.</p>
          <CopyableCmd cmd={inviteUrl} onCopy={onInviteCopied} />
        </>
      )}
      {extra}
      <FlowActions
        primary={<button type="button" className="ui-btn ui-btn--primary" onClick={onOpenDraft}>Open Draft</button>}
        secondary={<button type="button" className="ui-link" onClick={onConnectSource}>Connect a source</button>}
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
export function ReadingScreen({ sources, inviteUrl, onInviteCopied, extra, onOpenDraft }: {
  sources: ReadingSource[];
  inviteUrl?: string | null;
  onInviteCopied?: () => void;
  /** Shown above the Open Draft button, for example the web app's desktop download card. */
  extra?: ReactNode;
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
      {inviteUrl && (
        <>
          <h2 className="ui-group-label">Invite a teammate</h2>
          <p className="ui-flow__subtitle">Anyone with this link joins your team and sees this context.</p>
          <CopyableCmd cmd={inviteUrl} onCopy={onInviteCopied} />
        </>
      )}
      {extra}
      <FlowActions
        primary={<button type="button" className="ui-btn ui-btn--primary" onClick={onOpenDraft}>Open Draft</button>}
        note="Context appears in the Context tab when it is ready."
      />
    </>
  );
}

export function FirstContextScreen({ entry, inviteUrl, onInviteCopied, agentPrompt, onOpenContext }: {
  entry: ContextFileEntry;
  inviteUrl: string | null;
  onInviteCopied?: () => void;
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
          <CopyableCmd cmd={inviteUrl} onCopy={onInviteCopied} />
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
export function FirstUserFlow({ toolList, hasSource, readingSources, entries, inviteUrl, agentPrompt, onImportFolder, sourceFooter, readingExtra, onReadingChange, track, onFinish, error }: {
  toolList: ReactNode;
  hasSource: boolean;
  readingSources: ReadingSource[];
  entries: ContextFileEntry[];
  inviteUrl: string | null;
  agentPrompt: string;
  onImportFolder?: () => void;
  /** Under the tool list on "Give Draft something to read". */
  sourceFooter?: ReactNode;
  /** On "Draft is reading", above the Open Draft button. */
  readingExtra?: ReactNode;
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
          footer={sourceFooter}
          onNext={() => setStep("reading")}
          onSkip={() => {
            track("onboarding_skipped", { step: "give_source" });
            setStep("ready");
          }}
        />
      )}
      {shown === "ready" && (
        <ReadyScreen
          inviteUrl={inviteUrl}
          onInviteCopied={() => track("invite_link_copied", { surface: "ready" })}
          extra={readingExtra}
          onOpenDraft={() => finish("context", "completed")}
          onConnectSource={() => finish("connections", "completed")}
        />
      )}
      {shown === "reading" && (
        <ReadingScreen
          sources={readingSources}
          inviteUrl={inviteUrl}
          onInviteCopied={() => track("invite_link_copied", { surface: "reading" })}
          extra={readingExtra}
          onOpenDraft={() => finish("context", "completed")}
        />
      )}
      {shown === "first_context" && first && (
        <FirstContextScreen
          entry={first}
          inviteUrl={inviteUrl}
          onInviteCopied={() => track("invite_link_copied", { surface: "first_context" })}
          agentPrompt={agentPrompt}
          onOpenContext={() => finish("context", "completed")}
        />
      )}
    </FlowShell>
  );
}

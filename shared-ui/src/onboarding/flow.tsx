"use client";

import { Brand } from "../Brand";
import { useEffect, useState, type ReactNode } from "react";
import { contextExcerpt, type ContextFileEntry } from "../context/context-files";
import type { FlowStep, TrackFn } from "../analytics/events";

/** Full window, no sidebar, one centered column. Also used by web-only screens (invite, confirm join). */
export function FlowShell({ children }: { children: ReactNode }) {
  return (
    <div className="ui-flow">
      <header className="ui-flow__header">
        <span className="ui-wordmark"><Brand /></span>
      </header>
      <main className="ui-flow__column">{children}</main>
    </div>
  );
}

export function FlowActions({ primary, secondary, note }: { primary: ReactNode; secondary?: ReactNode; note?: string }) {
  return (
    <div className="ui-flow__actions">
      <div className="ui-flow__buttons">
        {primary}
        {secondary}
      </div>
      {note && <p className="ui-flow__note">{note}</p>}
    </div>
  );
}

export function WhatDraftKnowsScreen({ orgName, entries, onOpenContext, onConnectTools }: {
  orgName: string;
  entries: ContextFileEntry[];
  onOpenContext: () => void;
  onConnectTools: () => void;
}) {
  const company = entries.find((entry) => entry.kind === "dim" && entry.group === "company");
  const others = entries.filter((entry) => entry !== company && (entry.kind === "dim" || entry.kind === "standalone"));
  return (
    <>
      <h1 className="ui-flow__title">Here is what Draft knows about {orgName}</h1>
      {company && <p className="ui-flow__lede">{contextExcerpt(company.content, 420)}</p>}
      {others.length > 0 && (
        <section aria-label="Also in your team context">
          <h2 className="ui-group-label">Also in your team context</h2>
          <ul className="ui-rows">
            {others.map((entry) => (
              <li key={entry.relativePath} className="ui-dimension-row">
                <span className="ui-dimension-row__name">{entry.label}</span>
                <span className="ui-dimension-row__summary">{contextExcerpt(entry.content, 110)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <FlowActions
        primary={<button type="button" className="ui-btn ui-btn--primary ui-btn--wide" onClick={onOpenContext}>Open context</button>}
        secondary={<button type="button" className="ui-link" onClick={onConnectTools}>Connect your tools</button>}
      />
    </>
  );
}

export function ConnectToolsScreen({ toolList, onNext, onSkip, onBrowseAll }: {
  toolList: ReactNode;
  onNext: () => void;
  onSkip: () => void;
  onBrowseAll: () => void;
}) {
  return (
    <>
      <h1 className="ui-flow__title">Connect your tools</h1>
      <p className="ui-flow__subtitle">Your meetings and agent are yours. Team sources are already set up.</p>
      {toolList}
      <button type="button" className="ui-link ui-flow__browse" onClick={onBrowseAll}>Browse all tools</button>
      <FlowActions
        primary={<button type="button" className="ui-btn ui-btn--primary" onClick={onNext}>Next</button>}
        secondary={<button type="button" className="ui-link" onClick={onSkip}>Skip</button>}
        note="You can change these later in Connections and Settings."
      />
    </>
  );
}

export type FlowDestination = "context" | "connections";

/** Joiner flow: Here is what Draft knows, then Connect your tools. The host sets the completion flag in onFinish. */
export function JoinerFlow({ orgName, entries, toolList, track, onFinish, error }: {
  orgName: string;
  entries: ContextFileEntry[];
  toolList: ReactNode;
  track: TrackFn;
  onFinish: (destination: FlowDestination) => void;
  /** Shown above the screen, for example when saving the completion flag fails. */
  error?: string | null;
}) {
  // With no context yet there is nothing to read, so start at the tools.
  const [step, setStep] = useState<FlowStep>(entries.length ? "what_draft_knows" : "connect_tools");
  useEffect(() => { track("onboarding_step_viewed", { step }); }, [step]);

  function finish(destination: FlowDestination, outcome: "completed" | "skipped") {
    track(outcome === "completed" ? "onboarding_completed" : "onboarding_skipped", { step });
    onFinish(destination);
  }

  return (
    <FlowShell>
      {error && <p className="ui-error" role="alert">{error}</p>}
      {step === "what_draft_knows" ? (
        <WhatDraftKnowsScreen
          orgName={orgName}
          entries={entries}
          onOpenContext={() => finish("context", "completed")}
          onConnectTools={() => setStep("connect_tools")}
        />
      ) : (
        <ConnectToolsScreen
          toolList={toolList}
          onNext={() => finish("context", "completed")}
          onSkip={() => finish("context", "skipped")}
          onBrowseAll={() => finish("connections", "completed")}
        />
      )}
    </FlowShell>
  );
}

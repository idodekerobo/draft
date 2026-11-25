"use client";

import type { NeedsYou } from "./types";

type Facts = NonNullable<NeedsYou["getStarted"]>;

interface Props {
  facts: Facts;
  onOpenConnections: () => void;
  onOpenRoutines: () => void;
}

/** Shown on Home until the first to-do arrives, so the screen is never blank after onboarding. */
export function GetStartedChecklist({ facts, onOpenConnections, onOpenRoutines }: Props) {
  const steps = [
    { id: "source", label: "Connect a meeting source", done: facts.meetingSource, action: { label: "Connect", run: onOpenConnections } },
    { id: "routine", label: "Turn on a routine", done: facts.routine, action: { label: "Open routines", run: onOpenRoutines } },
    { id: "meeting", label: "Wait for your first meeting", done: facts.firstTodo, action: null },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  return (
    <section className="ui-home-checklist" aria-labelledby="get-started-title">
      <h3 id="get-started-title" className="ui-home-checklist__title">Get started <span className="ui-muted">{doneCount} of {steps.length}</span></h3>
      <div className="ui-home-checklist__bar" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount} aria-label="Get started progress"><span style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
      <ul className="ui-rows">
        {steps.map((step) => (
          <li key={step.id} className="ui-activity-row ui-home-row">
            <div className="ui-activity-row__text">
              <span className="ui-home-checklist__label"><span className={`ui-home-checklist__circle${step.done ? " ui-home-checklist__circle--done" : ""}`} aria-hidden="true">{step.done ? "✓" : ""}</span>{step.label}<span className="ui-visually-hidden">{step.done ? " (done)" : " (not done)"}</span></span>
            </div>
            <div className="ui-home-row__actions">
              {step.action && !step.done && <button type="button" className="ui-btn" onClick={step.action.run}>{step.action.label}</button>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

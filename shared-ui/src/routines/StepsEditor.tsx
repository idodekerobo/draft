"use client";

import { getHarness, type HarnessId } from "draft-core/harnesses";
import { useId, type ReactNode } from "react";
import { Select } from "../controls/Select";
import type { RoutineStepEdit } from "./types";

export const MAX_STEPS = 10;
const KEY_MAX = 32;

/** Once a routine has steps, its own text box is the goal of the whole routine, and the steps do the work. */
export const STEPS_GOAL_LABEL = "What is this routine for?";
export const STEPS_GOAL_HELP = "The goal of the whole routine. Each step below does part of the work.";

/** A step key: lowercase letters, numbers and underscores, starting with a letter. */
export function sanitizeStepKey(text: string): string {
  const cleaned = text.toLowerCase().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
  return cleaned.replace(/^[^a-z]+/, "").slice(0, KEY_MAX);
}

/** A step list in order. Each step reads the one before it, so reordering or renaming keeps that chain right. */
export function chainSteps(steps: ReadonlyArray<RoutineStepEdit>): RoutineStepEdit[] {
  return steps.map((step, index) => {
    const { inputsFrom: _old, ...rest } = step;
    return index === 0 ? rest : { ...rest, inputsFrom: [steps[index - 1]!.key] };
  });
}

/** The first problem with a list, in words, or null when it can be saved. */
export function stepsProblem(steps: ReadonlyArray<RoutineStepEdit>): string | null {
  const seen = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(step.key)) return `Step ${index + 1} needs a name made of letters, numbers and underscores.`;
    if (seen.has(step.key)) return `Two steps are named “${step.key}”. Give each its own name.`;
    if (step.prompt.trim() === "") return `Step ${index + 1} needs instructions.`;
    seen.add(step.key);
  }
  return null;
}

const nextKey = (steps: ReadonlyArray<RoutineStepEdit>): string => {
  const taken = new Set(steps.map((step) => step.key));
  for (let number = steps.length + 1; ; number += 1) if (!taken.has(`step_${number}`)) return `step_${number}`;
};

/** The step list of an agent routine. A routine with no steps runs as one agent. Render it inside `.ui-routines__fields`. */
export function StepsEditor({ steps, onChange, harness, goal, disabled, fieldError }: {
  steps: RoutineStepEdit[];
  onChange: (steps: RoutineStepEdit[]) => void;
  harness: HarnessId;
  /** The routine's own request. The first step starts from it. */
  goal: string;
  disabled: boolean;
  fieldError: (field: string) => ReactNode;
}) {
  const ids = useId();
  const models = getHarness(harness)?.models ?? [];
  const modelOptions = models.map((model) => ({ value: model.alias ?? "", label: model.alias === null ? "Default for this agent" : model.label }));
  const problem = stepsProblem(steps);

  const update = (index: number, change: Partial<RoutineStepEdit>) => onChange(chainSteps(steps.map((step, at) => (at === index ? { ...step, ...change } : step))));
  const move = (index: number, by: -1 | 1) => {
    const next = [...steps];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    onChange(chainSteps(next));
  };
  const blank = (key: string, prompt: string): RoutineStepEdit => ({ key, prompt, model: null, fanOut: { over: "none" }, output: { type: "text" } });

  if (steps.length === 0) {
    return (
      <div className="ui-routines__field ui-routines__field--wide">
        Steps
        <p className="ui-routines__secondary">Split a long job into steps. Each step runs in its own agent, one after another, and sees what the steps before it found.</p>
        <div>
          <button type="button" className="ui-routines__btn" disabled={disabled} onClick={() => onChange(chainSteps([blank("step_1", goal), blank("step_2", "")]))}>Split into steps</button>
        </div>
        {fieldError("steps")}
      </div>
    );
  }

  return (
    <div className="ui-routines__field ui-routines__field--wide" role="group" aria-label="Steps">
      Steps
      <p className="ui-routines__secondary">Each step runs in its own agent, one after another, and sees what the steps before it found.</p>
      <ol className="ui-steps">
        {steps.map((step, index) => {
          const label = `step ${index + 1}, ${step.key || "unnamed"}`;
          const perDocument = step.fanOut.over === "context_documents";
          return (
            <li key={index} className="ui-steps__item">
              <div className="ui-steps__head">
                <span className="ui-steps__num">Step {index + 1}</span>
                <span className="ui-steps__tools">
                  <button type="button" className="ui-link" disabled={disabled || index === 0} aria-label={`Move ${label} up`} onClick={() => move(index, -1)}>Move up</button>
                  <button type="button" className="ui-link" disabled={disabled || index === steps.length - 1} aria-label={`Move ${label} down`} onClick={() => move(index, 1)}>Move down</button>
                  <button type="button" className="ui-link" disabled={disabled} aria-label={`Remove ${label}`} onClick={() => onChange(chainSteps(steps.filter((_, at) => at !== index)))}>Remove</button>
                </span>
              </div>
              <label className="ui-routines__field">
                Name
                <input type="text" value={step.key} maxLength={KEY_MAX} disabled={disabled} aria-label={`Name of ${label}`} placeholder="collect_facts" onChange={(event) => update(index, { key: sanitizeStepKey(event.target.value) })} />
              </label>
              <label className="ui-routines__field ui-routines__field--wide">
                What should it do?
                <textarea value={step.prompt} rows={3} maxLength={20000} disabled={disabled} aria-label={`Instructions for ${label}`} placeholder="Read the new customer notes and list each decision that was made." onChange={(event) => update(index, { prompt: event.target.value })} />
              </label>
              <div className="ui-routines__field">
                Model
                <Select<string> label={`Model for ${label}`} value={step.model ?? ""} disabled={disabled} options={modelOptions} onChange={(model) => update(index, { model: model === "" ? null : model })} />
              </div>
              <label className="ui-steps__check" htmlFor={`${ids}-${index}-docs`}>
                <input id={`${ids}-${index}-docs`} type="checkbox" checked={perDocument} disabled={disabled} onChange={(event) => update(index, { fanOut: event.target.checked ? { over: "context_documents", filter: "all_stable" } : { over: "none" } })} />
                Run once for each document in the company context
              </label>
            </li>
          );
        })}
      </ol>
      <div className="ui-steps__foot">
        <button type="button" className="ui-routines__btn" disabled={disabled || steps.length >= MAX_STEPS} onClick={() => onChange(chainSteps([...steps, blank(nextKey(steps), "")]))}>Add a step</button>
        <button type="button" className="ui-link" disabled={disabled} onClick={() => onChange([])}>Go back to a single agent</button>
      </div>
      {problem && <span className="ui-routines__error" role="alert">{problem}</span>}
      {fieldError("steps")}
    </div>
  );
}

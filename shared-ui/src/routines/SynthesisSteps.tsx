"use client";

import { getHarness, type HarnessId } from "draft-core/harnesses";
import { SYNTHESIS_STEP_KEYS, SYNTHESIS_STEP_MODELS } from "draft-core/synthesis-steps";

const PURPOSE = {
  capture: "Reads the new sources and notes what matters. Writes nothing.",
  reconcile: "Checks each document against the new evidence, and fixes what is out of date.",
  organize: "Writes the notes into memory, records what could not be settled, and keeps the people list right.",
} as const;

const LABEL = { capture: "Capture", reconcile: "Reconcile", organize: "Organize" } as const;

/** The three steps of a context update, and the model each uses on the chosen agent. Read only: Draft owns their instructions. */
export function SynthesisSteps({ harness, model }: { harness: HarnessId; model: string | null }) {
  const models = getHarness(harness)?.models ?? [];
  const modelLabel = (alias: string) => models.find((entry) => entry.alias === alias)?.label ?? alias;
  return (
    <section className="ui-routines__agent" aria-label="Steps of a context update">
      <h3 className="ui-routines__subheading">Steps</h3>
      <ol className="ui-synthesis-steps">
        {SYNTHESIS_STEP_KEYS.map((key) => (
          <li key={key} className="ui-synthesis-steps__item">
            <p className="ui-synthesis-steps__name">{LABEL[key]} <span className="ui-routines__secondary">uses {modelLabel(model ?? SYNTHESIS_STEP_MODELS[key][harness])}</span></p>
            <p className="ui-routines__secondary">{PURPOSE[key]}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

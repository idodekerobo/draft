import { effortAfterModelChange, effortLabel, getHarness, modelEfforts, modelLabel, type HarnessId } from "draft-core/harnesses";
import type { PickerOption, PickerSection } from "./SectionedPicker";

export interface AgentChoice {
  harness: HarnessId;
  model: string | null;
  effort: string | null;
}

/** What "Default" means on this computer. Only the desktop app knows, because the harness's own settings are on that computer. */
export interface AgentDefaultsView {
  modelLabel: string | null;
  effort: string | null;
}

/** The effort a choice runs with: the one picked, else what Default means for that model. Null when it is not known. */
export function resolvedEffort({ harness, model, effort }: AgentChoice, defaults?: AgentDefaultsView | null): string | null {
  if (effort) return effort;
  if (model === null) return defaults?.effort ?? null;
  return getHarness(harness)?.models.find((option) => option.alias === model)?.defaultEffort ?? null;
}

/**
 * The picker's sections: harness, then the models of that harness, then the efforts of that model.
 * A choice of harness or model keeps the panel open, since the next list may still need a choice. Only an effort closes it.
 */
export function agentPickerSections({ value, onChange, harnesses, defaults, topRow = true, lockHarness = false }: {
  value: AgentChoice;
  onChange: (next: AgentChoice) => void;
  harnesses: ReadonlyArray<PickerOption>;
  defaults?: AgentDefaultsView | null;
  /** The harnesses sit in a row above the other lists. Without it, all lists stand side by side. */
  topRow?: boolean;
  /** A running session cannot change its harness, so the harness list is left out. */
  lockHarness?: boolean;
}): PickerSection[] {
  const { harness, model, effort } = value;
  const defaultEffort = resolvedEffort({ harness, model, effort: null }, defaults);
  const sections: PickerSection[] = [
    {
      id: "model",
      title: "Models",
      value: model ?? "",
      keepOpen: true,
      onChange: (next) => onChange({ harness, model: next || null, effort: effortAfterModelChange(harness, next || null, effort) }),
      options: (getHarness(harness)?.models ?? []).map((option) => ({ value: option.alias ?? "", label: option.label, hint: option.alias === null ? (defaults?.modelLabel ?? undefined) : undefined })),
    },
    {
      id: "effort",
      title: "Reasoning effort",
      value: effort ?? "",
      onChange: (next) => onChange({ harness, model, effort: next || null }),
      options: [{ value: "", label: "Default", hint: defaultEffort ? effortLabel(defaultEffort) : undefined }, ...modelEfforts(harness, model).map((next) => ({ value: next, label: effortLabel(next) }))],
    },
  ];
  if (lockHarness) return sections;
  return [{ id: "harness", title: "Harnesses", row: topRow, value: harness, keepOpen: true, onChange: (next) => onChange({ harness: next as HarnessId, model: null, effort: null }), options: [...harnesses] }, ...sections];
}

/** The picker button's text, such as "Codex · GPT-6-Sol · High". Default shows what it means on this computer when that is known. */
export function agentSummary(harness: string, model: string | null, effort: string | null, defaults?: AgentDefaultsView | null, withHarness = true): string {
  const modelName = model ? modelLabel(harness, model) : (defaults?.modelLabel ?? modelLabel(harness, null));
  const level = resolvedEffort({ harness: harness as HarnessId, model, effort }, defaults);
  const parts = [withHarness ? (getHarness(harness)?.label ?? harness) : null, modelName, level ? effortLabel(level) : null];
  return parts.filter(Boolean).join(" · ");
}

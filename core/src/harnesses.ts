/** The coding agents Draft can run for a session or a routine. The apps and the backend read only this list. */

export interface HarnessModel {
  /** Goes to the harness CLI as its model name. Null leaves the choice to the harness's own setting. */
  alias: string | null;
  label: string;
}

export interface HarnessDefinition {
  id: string;
  label: string;
  models: ReadonlyArray<HarnessModel>;
  capabilities: { terminal: boolean; approvals: boolean; steer: boolean };
  /** How a cloud routine runs this harness. Empty when routines do not support it yet. */
  routineModes: ReadonlyArray<"print" | "exec">;
}

export const HARNESSES = [
  {
    id: "claude",
    label: "Claude Code",
    models: [
      { alias: null, label: "Default" },
      { alias: "fable", label: "Fable" },
      { alias: "opus", label: "Opus" },
      { alias: "sonnet", label: "Sonnet" },
      { alias: "haiku", label: "Haiku" },
    ],
    capabilities: { terminal: true, approvals: true, steer: false },
    routineModes: ["print"],
  },
] as const satisfies ReadonlyArray<HarnessDefinition>;

export type HarnessId = (typeof HARNESSES)[number]["id"];

export const DEFAULT_HARNESS_ID: HarnessId = "claude";

export function getHarness(id: string | null | undefined): HarnessDefinition | null {
  return HARNESSES.find((harness) => harness.id === id) ?? null;
}

export const isHarnessId = (id: unknown): id is HarnessId => typeof id === "string" && getHarness(id) !== null;

/** The harness's label, or the raw id for one this build does not know. */
export function harnessLabel(id: string): string {
  return getHarness(id)?.label ?? id;
}

export function harnessModels(id: string): ReadonlyArray<HarnessModel> {
  return getHarness(id)?.models ?? [];
}

export function isKnownModel(harnessId: string, alias: string | null | undefined): boolean {
  return harnessModels(harnessId).some((model) => model.alias === (alias ?? null));
}

/** "Opus", or the raw alias for one this build does not know. Null for the harness default. */
export function modelLabel(harnessId: string, alias: string | null | undefined): string | null {
  if (!alias) return harnessModels(harnessId).find((model) => model.alias === null)?.label ?? null;
  return harnessModels(harnessId).find((model) => model.alias === alias)?.label ?? alias;
}

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
  /** The CLI release the host was tested with: this major and minor. */
  testedVersion: { major: number; minor: number };
  /** How a cloud routine runs this harness. Empty when routines do not support it yet. */
  routineModes: ReadonlyArray<"print" | "exec">;
  /** Where a person installs the harness's CLI. */
  installUrl?: string;
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
    testedVersion: { major: 2, minor: 1 },
    routineModes: ["print"],
  },
  {
    id: "codex",
    label: "Codex",
    models: [
      { alias: null, label: "Default" },
      { alias: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
      { alias: "gpt-6-astra", label: "GPT-6-Astra" },
      { alias: "gpt-6.1-terra", label: "GPT-6.1 Terra" },
      { alias: "gpt-6-sol", label: "GPT-6-Sol" },
      { alias: "gpt-6-luna", label: "GPT-6-Luna" },
      { alias: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
      { alias: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
      { alias: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
    ],
    capabilities: { terminal: true, approvals: true, steer: true },
    testedVersion: { major: 0, minor: 165 },
    routineModes: ["exec"],
    installUrl: "https://learn.chatgpt.com/docs/codex/cli#getting-started",
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

export const harnessInstallUrl = (id: string): string | null => getHarness(id)?.installUrl ?? null;

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

/** The version number in the output of a CLI's `--version`. */
export function parseCliVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null;
}

/** True or false for a known version, null when the version or the harness is not known. */
export function isTestedVersion(harnessId: string, version: string | null | undefined): boolean | null {
  const tested = getHarness(harnessId)?.testedVersion;
  const parsed = version ? parseCliVersion(version) : null;
  if (!tested || !parsed) return null;
  const [major, minor] = parsed.split(".").map(Number);
  return major === tested.major && minor === tested.minor;
}

export function testedVersionLabel(harnessId: string): string | null {
  const tested = getHarness(harnessId)?.testedVersion;
  return tested ? `${tested.major}.${tested.minor}.x` : null;
}

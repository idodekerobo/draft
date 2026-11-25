/** The coding agents Draft can run for a session or a routine. The apps and the backend read only this list. */
import { claudeDefinition } from "./claude/definition";
import { codexDefinition } from "./codex/definition";
import { isCloudNativeTool, type AgentRunToolset, type McpServerPermission, type NativeToolPermission } from "../run-spec";
import { REASONING_EFFORTS, type HarnessDefinition, type HarnessModel, type HarnessModes, type ReasoningEffort } from "./types";

export { ADAPTERS, adapterSupportsTarget, getAdapter, interactiveAdapterFor, isAdapterId, requireAdapter, requireInteractiveAdapter, requireRoutineAdapter, routineAdapterFor } from "./adapters";
export type { AdapterCapabilities, AdapterDefinition, AdapterId, ExecutionTargetType } from "./adapters";
export { REASONING_EFFORTS } from "./types";
export type { HarnessDefinition, HarnessModel, HarnessModeOption, HarnessModes, ReasoningEffort } from "./types";

export const HARNESSES = [claudeDefinition, codexDefinition] as const satisfies ReadonlyArray<HarnessDefinition>;

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

/** Modes Claude can start in but Shift+Tab never reaches. A host may report them, and no one can switch to them. */
export const CLAUDE_LAUNCH_ONLY_MODES = ["bypassPermissions", "dontAsk"] as const;

/** The values of a harness's mode menus. */
export function harnessModeValues(id: string, axis: keyof HarnessModes): string[] {
  return harnessModes(id)[axis].map((mode) => mode.value);
}

/** The mode menu for a harness, or empty lists for one this build does not know. */
export function harnessModes(id: string | null | undefined, model?: string | null): HarnessModes {
  const harness = getHarness(id);
  const modes = harness?.modes ?? { permission: [], approval: [] };
  const supported: HarnessModel | undefined = harness?.models.find((entry) => entry.alias === (model ?? null));
  if (!supported?.modes) return modes;
  return {
    permission: modes.permission.filter((option) => !supported.modes?.permission || supported.modes.permission.includes(option.value)),
    approval: modes.approval.filter((option) => !supported.modes?.approval || supported.modes.approval.includes(option.value)),
  };
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

export const isReasoningEffort = (value: unknown): value is ReasoningEffort => (REASONING_EFFORTS as ReadonlyArray<unknown>).includes(value);

const EFFORT_LABELS: Record<ReasoningEffort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };

/** "Extra high", or the raw value for one this build does not know. */
export const effortLabel = (effort: string): string => (isReasoningEffort(effort) ? EFFORT_LABELS[effort] : effort);

/** The efforts a model accepts. An alias this build does not know gets none. */
export function modelEfforts(harnessId: string, alias: string | null | undefined): ReadonlyArray<ReasoningEffort> {
  return harnessModels(harnessId).find((model) => model.alias === (alias ?? null))?.efforts ?? [];
}

/** True when the model accepts the effort. Null means no effort, which every model accepts. */
export function isEffortFor(harnessId: string, alias: string | null | undefined, effort: string | null | undefined): boolean {
  return effort == null || (modelEfforts(harnessId, alias) as ReadonlyArray<string>).includes(effort);
}

/** The effort to carry over when the model changes. Default stays Default; a set effort stays when the new model accepts it, else it becomes that model's default. */
export function effortAfterModelChange(harnessId: string, alias: string | null | undefined, effort: string | null | undefined): ReasoningEffort | null {
  if (!effort) return null;
  if (isEffortFor(harnessId, alias, effort)) return effort as ReasoningEffort;
  return harnessModels(harnessId).find((model) => model.alias === (alias ?? null))?.defaultEffort ?? null;
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

/**
 * What a cloud run may use: the harness's starting tools, the built-in tools a person added, and the
 * connections they chose. A tool outside the cloud list is dropped, even if it was saved earlier.
 */
export function cloudToolsetFor(
  harness: HarnessId,
  chosen?: { nativeTools?: ReadonlyArray<string>; mcpServers?: ReadonlyArray<McpServerPermission> },
): AgentRunToolset {
  const definition = HARNESSES.find((entry) => entry.id === harness)!;
  const nativeTools = definition.cloudStartingTools.map((tool) => ({ harness, tool }) as NativeToolPermission);
  for (const tool of chosen?.nativeTools ?? []) {
    const permission = { harness, tool } as NativeToolPermission;
    if (isCloudNativeTool(permission) && !nativeTools.some((existing) => existing.tool === permission.tool)) nativeTools.push(permission);
  }
  return { nativeTools, mcpServers: [...(chosen?.mcpServers ?? [])], skills: [], instructions: [] };
}

/** The coding agents Draft can run for a session or a routine. The apps and the backend read only this list. */
import { claudeDefinition } from "./claude/definition";
import { codexDefinition } from "./codex/definition";
import { isCloudNativeTool, type AgentRunEnvironment, type McpServerPermission, type NativeToolPermission } from "../run-spec";
import type { HarnessDefinition, HarnessModel, HarnessModes } from "./types";

export type { HarnessDefinition, HarnessModel, HarnessModeOption, HarnessModes } from "./types";

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
export function harnessModes(id: string | null | undefined): HarnessModes {
  return getHarness(id)?.modes ?? { permission: [], approval: [] };
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

/**
 * What a cloud run may use: the harness's starting tools, the built-in tools a person added, and the
 * connections they chose. A tool outside the cloud list is dropped, even if it was saved earlier.
 */
export function cloudEnvironmentFor(
  harness: HarnessId,
  chosen?: { nativeTools?: ReadonlyArray<string>; mcpServers?: ReadonlyArray<McpServerPermission> },
): AgentRunEnvironment {
  const definition = HARNESSES.find((entry) => entry.id === harness)!;
  const nativeTools = definition.cloudStartingTools.map((tool) => ({ harness, tool }) as NativeToolPermission);
  for (const tool of chosen?.nativeTools ?? []) {
    const permission = { harness, tool } as NativeToolPermission;
    if (isCloudNativeTool(permission) && !nativeTools.some((existing) => existing.tool === permission.tool)) nativeTools.push(permission);
  }
  return { nativeTools, mcpServers: [...(chosen?.mcpServers ?? [])], skills: [], instructions: [] };
}

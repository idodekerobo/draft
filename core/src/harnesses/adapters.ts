/** The adapter registry. It reads only the harness folders' adapter lists, so run-spec and the runner bundle can import it. */
import type { AdapterDefinition, ExecutionTargetType } from "./adapter-types";
import { claudeAdapters } from "./claude/adapters";
import { codexAdapters } from "./codex/adapters";

export type { AdapterCapabilities, AdapterDefinition, ExecutionTargetType } from "./adapter-types";

export const ADAPTERS = [...claudeAdapters, ...codexAdapters] as const;

export type AdapterId = (typeof ADAPTERS)[number]["id"];

const ALL: ReadonlyArray<AdapterDefinition> = ADAPTERS;

export const getAdapter = (id: string | null | undefined): AdapterDefinition | null => ALL.find((adapter) => adapter.id === id) ?? null;

export const isAdapterId = (id: unknown): id is AdapterId => typeof id === "string" && getAdapter(id) !== null;

/** The adapter, or an error for an id this build does not know. Never a default. */
export function requireAdapter(id: string | null | undefined): AdapterDefinition {
  const adapter = getAdapter(id);
  if (!adapter) throw new Error(`Unknown adapter: ${id ?? "(none)"}`);
  return adapter;
}

/** The adapter that runs a harness in a live session, or null for a harness this build does not know. */
export const interactiveAdapterFor = (harness: string | null | undefined): AdapterDefinition | null =>
  ALL.find((adapter) => adapter.harness === harness && adapter.kind === "interactive") ?? null;

/** The adapter that runs a harness for a routine, or null for a harness this build does not know. */
export const routineAdapterFor = (harness: string | null | undefined): AdapterDefinition | null =>
  ALL.find((adapter) => adapter.harness === harness && adapter.kind === "routine") ?? null;

/** The live-session adapter of a harness. Throws for a harness this build does not know, or none. */
export function requireInteractiveAdapter(harness: string | null | undefined): AdapterDefinition {
  const adapter = interactiveAdapterFor(harness);
  if (!adapter) throw new Error(`No adapter runs harness: ${harness ?? "(none)"}`);
  return adapter;
}

export const adapterSupportsTarget = (adapter: AdapterDefinition, target: ExecutionTargetType): boolean => adapter.targets.includes(target);

/** The built-in tools a cloud run of the harness may be given: what its sandbox adapters allow. */
export function cloudNativeToolsFor(harness: string): ReadonlyArray<string> {
  const tools = ALL.filter((adapter) => adapter.harness === harness && adapter.targets.includes("sandbox")).flatMap((adapter) => adapter.cloudNativeTools);
  return [...new Set<string>(tools)];
}

/** True when the harness has a built-in tool of this name. */
export const isNativeTool = (harness: string, tool: string): boolean =>
  ALL.some((adapter) => adapter.harness === harness && adapter.nativeTools.includes(tool));

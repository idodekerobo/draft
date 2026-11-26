import { STEP_FILE_PREFIX } from "../synthesis/context-version-files";
import type { StepOutputs } from "./types";

/** The files an earlier step's runs left for a later one to read, by bundle path. */
export function stepFiles(outputs: StepOutputs): Record<string, string> {
  return Object.fromEntries(
    Object.entries(outputs).flatMap(([key, list]) => list.map((entry) => [`${STEP_FILE_PREFIX}${key}/${entry.run.id}.json`, `${JSON.stringify(entry.result, null, 2)}\n`] as const)),
  );
}

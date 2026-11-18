import { claudeRunner } from "draft-core/harnesses/claude/runner";
import { codexRunner } from "draft-core/harnesses/codex/runner";
import type { RunnerSide } from "draft-core/harnesses/types";
import type { RunnerManifest } from "draft-core/run-manifest";

// The only place that names a harness. A new harness adds one entry.
const SIDES: Record<RunnerManifest["harness"], RunnerSide> = { claude: claudeRunner, codex: codexRunner };

export const runnerSideFor = (harness: RunnerManifest["harness"]): RunnerSide => SIDES[harness];

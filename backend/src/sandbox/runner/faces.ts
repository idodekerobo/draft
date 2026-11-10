import { claudeRunner } from "draft-core/harnesses/claude/runner";
import { codexRunner } from "draft-core/harnesses/codex/runner";
import type { RunnerSide } from "draft-core/harnesses/types";
import type { RunnerManifest } from "draft-core/run-manifest";

// The only place that names a harness. A new harness adds one entry.
const FACES: Record<RunnerManifest["harness"], RunnerSide> = { claude: claudeRunner, codex: codexRunner };

export const runnerFaceFor = (harness: RunnerManifest["harness"]): RunnerSide => FACES[harness];

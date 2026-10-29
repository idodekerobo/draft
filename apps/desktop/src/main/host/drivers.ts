import { DEFAULT_HARNESS_ID, type HarnessId } from "draft-core/harnesses";
import { claude } from "./claude-driver";
import { codex } from "./codex/codex-driver";
import type { HarnessRegistration } from "./harness-driver";

const DRIVERS: Record<HarnessId, HarnessRegistration> = { claude, codex };

/** The driver of a saved session. A state file from before harnesses were recorded means Claude. */
export function registrationFor(harness: string | undefined): HarnessRegistration {
  return DRIVERS[(harness ?? DEFAULT_HARNESS_ID) as HarnessId] ?? claude;
}

import type { AdapterId } from "../../harnesses/adapters";
import { requireAdapter } from "../../harnesses/adapters";
import { claude } from "./claude/claude-driver";
import { codex } from "./codex/codex-driver";
import type { HarnessRegistration } from "./harness-driver";

const DRIVERS: Partial<Record<AdapterId, HarnessRegistration>> = { "claude-terminal": claude, "codex-app-server": codex };

/** The driver of an adapter. Throws for an id this build does not know, or one with no driver on a host. */
export function registrationFor(adapterId: string | undefined): HarnessRegistration {
  const adapter = requireAdapter(adapterId);
  const registration = DRIVERS[adapter.id as AdapterId];
  if (!registration) throw new Error(`Adapter ${adapter.id} has no host driver`);
  return registration;
}

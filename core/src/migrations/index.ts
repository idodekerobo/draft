import m20260628 from "./20260628000000_initial_framework";
import m20260629 from "./20260629142600_add_transcript_path";
import m20260629b from "./20260629213430_workspace_scoped_manifests";

export const migrations: Record<number, () => void | Promise<void>> = {
  20260628000000: m20260628,
  20260629142600: m20260629,
  20260629213430: m20260629b,
};

export const CURRENT_MIGRATION = Math.max(...Object.keys(migrations).map(Number));

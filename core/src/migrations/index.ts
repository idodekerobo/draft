import m20260628 from "./20260628000000_initial_framework";
import m20260629 from "./20260629142600_add_transcript_path";
import m20260629b from "./20260629213430_workspace_scoped_manifests";
import m20260709 from "./20260709195000_backfill_personal_skill_manifests";
import m20260709b from "./20260709223251_backfill_personal_mcp_manifests";

export const migrations: Record<number, () => void | Promise<void>> = {
  20260628000000: m20260628,
  20260629142600: m20260629,
  20260629213430: m20260629b,
  20260709195000: m20260709,
  20260709223251: m20260709b,
};

export const CURRENT_MIGRATION = Math.max(...Object.keys(migrations).map(Number));

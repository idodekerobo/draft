import type { SupabaseClient } from "@supabase/supabase-js";
import { ToolRegistry } from "../tool-registry";
import { createContextTools } from "./context-tools";
import { createPersonTools } from "./person-tools";

/** Every tool the Draft gateway serves. A new tool is added here and to DRAFT_TOOLS in core. */
export function createDraftToolRegistry(client: SupabaseClient): ToolRegistry {
  return new ToolRegistry([...createPersonTools(client), ...createContextTools(client)]);
}

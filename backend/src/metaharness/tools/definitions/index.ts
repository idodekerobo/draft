import type { SupabaseClient } from "@supabase/supabase-js";
import { ToolRegistry } from "../tool-registry";
import { createContextTools } from "./context";
import { createPeopleTools } from "./people";
import { createRoutineTools } from "./routines";
import { createSkillTools } from "./skills";
import { createSourceTools } from "./sources";
import { createSlackTools } from "./slack";
import { createGithubTools } from "./github";

/** Every tool the Draft gateway serves. A new tool is added here and to DRAFT_TOOLS in core. */
export function createDraftToolRegistry(client: SupabaseClient): ToolRegistry {
  return new ToolRegistry([...createContextTools(client), ...createSourceTools(client), ...createSkillTools(client), ...createRoutineTools(client), ...createPeopleTools(client), ...createSlackTools(client), ...createGithubTools(client)]);
}

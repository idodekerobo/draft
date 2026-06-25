// core/src/agents/prompts/setup.ts — prompt builder for headless context setup
//
// Pure function: inputs in, string out. No I/O, no side effects.
// Tune agent behavior here without touching spawn logic.

export interface BuildHeadlessSetupPromptOpts {
  workspace: string;
  installedTools: string[];
  connectedIntegrations: string[];
  /** Optional source summary. Local folder lists files; GitHub passes natural-language
   *  clone instructions (agent-led for this use case). */
  importSummary?: string;
}

export function buildHeadlessSetupPrompt(opts: BuildHeadlessSetupPromptOpts): string {
  const integrationList = opts.connectedIntegrations.length > 0
    ? opts.connectedIntegrations.join(", ")
    : "none";

  const toolList = opts.installedTools.length > 0
    ? opts.installedTools.join(", ")
    : "none";

  return [
    "You are running Draft's non-interactive context setup.",
    `Write the shared context workspace directly to: ${opts.workspace}`,
    `Installed tools: ${toolList}`,
    `Connected integrations: ${integrationList}`,
    opts.importSummary ?? "No local folder or repository was selected.",
    "Create or update concise context files for company, product, team, and priorities. Do not ask questions. Make conservative assumptions and mark them [ASSUMED]. Do not read or output secrets.",
  ].join("\n\n");
}

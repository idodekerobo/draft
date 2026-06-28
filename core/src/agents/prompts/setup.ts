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

  const workspace = opts.workspace;

  return `You are running Draft's non-interactive context setup.

**Workspace:** ${workspace}
**Installed tools:** ${toolList}
**Connected integrations:** ${integrationList}

${opts.importSummary ?? "No local folder or repository was selected."}

## Step 1 — Create the workspace directory structure

Run this Python block first to establish the correct layout:

\`\`\`python
from pathlib import Path
base = Path("${workspace}")
for subdir in [
    base / "context" / "company" / "log",
    base / "context" / "product" / "log",
    base / "context" / "team" / "log",
    base / "context" / "priorities" / "log",
    base / "context" / "decisions",
    base / "docs",
    base / "config",
]:
    subdir.mkdir(parents=True, exist_ok=True)
\`\`\`

## Step 2 — Write context index files

Write \`context/<dim>/index.md\` for each of: company, product, team, priorities.

Each file must have two parts:

1. **Frontmatter \`description\`** — the most important facts for this dimension, written concisely. This is loaded into the agent's context every session, so include what matters most — not everything, but nothing trivial either.
2. **Markdown body** — the full detailed record for this dimension. More context, history, open questions, supporting detail. This is what gets rendered in the UI and read when deeper context is needed.

Use this exact structure:

\`\`\`
---
name: <dim>
description: >
  <Most important facts about this dimension, concise. Loaded into agent context every session.>
last_updated: <today's date YYYY-MM-DD>
source: /headless-setup
---

# <Dim>

<Full detailed content. Use headers and bullet points. More than the description — this is the complete picture.>
\`\`\`

Body content by dimension:
- **company**: name, what they build, business model, stage, target market, key constraints
- **product**: product name, problem it solves, target user, key features, current state, open hypotheses
- **team**: who's on the team, roles, structure, how decisions get made
- **priorities**: active TODOs, current sprint goal, blockers, what success looks like

## Rules

- Do not ask questions
- Mark inferences with [ASSUMED]
- Do not write log entries (log/ dirs are for future updates only)
- Do not read or output secrets`;
}

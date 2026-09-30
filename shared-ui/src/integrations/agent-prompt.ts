// Copied by the agent row. Steps follow the root README (CLI install) and docs/cli.md (auth, `draft add`).

export const CLI_INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash";

export const AGENT_SETUP_PROMPT = [
  "Set up the Draft CLI so you can read my team's shared context in this project.",
  "",
  "1. Install the CLI (macOS or Linux):",
  `   ${CLI_INSTALL_COMMAND}`,
  "2. Sign me in. This opens my browser to approve:",
  "   draft auth login",
  "3. Connect this project. Use the name of the agent you are: claude-code, codex, cursor, openclaw or hermes:",
  "   draft add <agent> --dir .",
  "4. Check that it works:",
  "   draft context list",
  "",
  "Then tell me what `draft add` changed.",
].join("\n");

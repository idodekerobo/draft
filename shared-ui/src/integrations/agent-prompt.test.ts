import { describe, expect, test } from "bun:test";
import { AGENT_SETUP_PROMPT, CLI_INSTALL_COMMAND } from "./agent-prompt";

describe("AGENT_SETUP_PROMPT", () => {
  test("installs the CLI, signs in, and runs draft add", () => {
    expect(AGENT_SETUP_PROMPT).toContain(CLI_INSTALL_COMMAND);
    expect(AGENT_SETUP_PROMPT).toContain("draft auth login");
    expect(AGENT_SETUP_PROMPT).toContain("draft add <agent> --dir .");
    expect(AGENT_SETUP_PROMPT).not.toContain("DRAFT_");
  });
});

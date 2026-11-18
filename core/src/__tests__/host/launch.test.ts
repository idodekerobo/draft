import { describe, expect, it } from "bun:test";
import { buildClaudeCommand } from "../../host/launch";

describe("buildClaudeCommand", () => {
  it("adds --model and --effort only when they are set", () => {
    expect(buildClaudeCommand("/bin/claude", "abc", null)).not.toContain("--effort");
    const command = buildClaudeCommand("/bin/claude", "abc", "opus", null, false, "xhigh");
    expect(command).toContain("'--model' 'opus'");
    expect(command).toContain("'--effort' 'xhigh'");
  });

  it("keeps the effort when it resumes a conversation", () => {
    expect(buildClaudeCommand("/bin/claude", "abc", null, null, true, "high")).toContain("'--resume' 'abc' '--effort' 'high'");
  });
});

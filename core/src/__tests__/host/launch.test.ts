import { describe, expect, it } from "bun:test";
import { buildClaudeCommand } from "../../host/launch";

describe("buildClaudeCommand", () => {
  it("starts a selected Plan session with the native flag before any message is submitted", () => {
    expect(buildClaudeCommand("/bin/claude", "abc", "opus", null, false, "high", "plan")).toContain("'--permission-mode' 'plan'");
    expect(buildClaudeCommand("/bin/claude", "abc", null)).not.toContain("--permission-mode");
  });
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

it("adds a session MCP server without putting its capability in command arguments", () => {
  const connection = { serverName: "draft_session_one", url: "http://127.0.0.1:1234/mcp/one", token: "capability-secret", tokenEnvVar: "DRAFT_SESSION_MCP_TOKEN", tokenFile: "/tmp/private file.token" };
  const command = buildClaudeCommand("/bin/claude", "abc", null, null, true, null, undefined, connection);
  expect(command).toContain("--mcp-config");
  expect(command).toContain("draft_session_one");
  expect(command).toContain("${DRAFT_SESSION_MCP_TOKEN}");
  expect(command).toContain("cat '/tmp/private file.token'");
  expect(command).not.toContain("capability-secret");
  expect(command).not.toContain("strict-mcp-config");
});

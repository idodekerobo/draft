import type { CredentialRules } from "draft-core/harnesses/types";

/** The workspace's Claude Code login, stored by the connections route. It is a long-lived token that never rotates. */
export const claudeCredentialRules: CredentialRules = {
  provider: "claude_code",
  label: "Claude Code login",
  validate: (value) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null),
  changedDuringRun: () => false,
  lease: null,
};

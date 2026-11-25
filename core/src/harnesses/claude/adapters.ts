import type { AdapterDefinition } from "../adapter-types";

/** Claude Code tools a run may be given. Which of them are safe in the cloud is decided by the cloud list. */
export const CLAUDE_NATIVE_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Bash", "Edit", "Write"] as const;
export type ClaudeNativeTool = (typeof CLAUDE_NATIVE_TOOLS)[number];

export const claudeAdapters = [
  {
    id: "claude-terminal",
    harness: "claude",
    kind: "interactive",
    targets: ["host", "sandbox"],
    capabilities: { terminal: true, approvals: true, steer: false },
    eventPath: "lines",
    launchable: true,
    nativeTools: CLAUDE_NATIVE_TOOLS,
    cloudNativeTools: CLAUDE_NATIVE_TOOLS,
  },
  {
    id: "claude-print",
    harness: "claude",
    kind: "routine",
    targets: ["sandbox"],
    capabilities: { terminal: false, approvals: false, steer: false },
    eventPath: "lines",
    launchable: true,
    nativeTools: CLAUDE_NATIVE_TOOLS,
    cloudNativeTools: CLAUDE_NATIVE_TOOLS,
  },
] as const satisfies ReadonlyArray<AdapterDefinition>;

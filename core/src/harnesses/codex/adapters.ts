import type { AdapterDefinition } from "../adapter-types";

export const CODEX_NATIVE_TOOLS = ["web_search", "shell", "apply_patch"] as const;
export type CodexNativeTool = (typeof CODEX_NATIVE_TOOLS)[number];

export const codexAdapters = [
  {
    id: "codex-app-server",
    harness: "codex",
    kind: "interactive",
    targets: ["host"],
    capabilities: { terminal: true, approvals: true, steer: true },
    eventPath: "lines",
    launchable: true,
    nativeTools: CODEX_NATIVE_TOOLS,
    cloudNativeTools: [],
  },
  {
    id: "codex-exec",
    harness: "codex",
    kind: "routine",
    targets: ["sandbox"],
    capabilities: { terminal: false, approvals: false, steer: false },
    eventPath: "lines",
    launchable: true,
    nativeTools: CODEX_NATIVE_TOOLS,
    cloudNativeTools: ["shell", "web_search"],
  },
] as const satisfies ReadonlyArray<AdapterDefinition>;

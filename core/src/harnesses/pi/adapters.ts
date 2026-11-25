import type { AdapterDefinition } from "../adapter-types";

/** Registered so a spec can name it. There is no launcher: Home's runtime adds one. */
export const piAdapters = [
  {
    id: "pi-durable-sdk",
    harness: "pi",
    kind: "interactive",
    targets: ["backend"],
    capabilities: { terminal: false, approvals: false, steer: false, rawUpload: false },
    eventPath: "events",
    launchable: false,
    nativeTools: [],
    cloudNativeTools: [],
  },
] as const satisfies ReadonlyArray<AdapterDefinition>;

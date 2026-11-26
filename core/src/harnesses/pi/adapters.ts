import type { AdapterDefinition } from "../adapter-types";

/** Home's adapter. Draft's backend launches it in process (`backend/src/home/runtime/host.ts`); no other launcher takes a backend target. */
export const piAdapters = [
  {
    id: "pi-durable-sdk",
    harness: "pi",
    kind: "interactive",
    targets: ["backend"],
    capabilities: { terminal: false, approvals: true, steer: true, rawUpload: false },
    eventPath: "events",
    launchable: true,
    nativeTools: [],
    cloudNativeTools: [],
  },
] as const satisfies ReadonlyArray<AdapterDefinition>;

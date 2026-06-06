// utils/exec.ts — re-exports from draft-core/exec
//
// Subprocess wrappers live in draft-core/exec so the desktop app can reuse them.
// This file re-exports everything so existing `import { ... } from "../utils/exec.ts"`
// calls in CLI commands continue to work without changes.

export { type CaptureResult, spawn, capture } from "draft-core/exec";

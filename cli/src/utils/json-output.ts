// utils/json-output.ts — machine output contract for --json mode
// Machine output uses schema_version: 1 and normally writes exactly one object.
// Event streams such as auth and integration handoffs use JSONL instead.
// In --json mode, stdout contains JSON only: no ANSI, prose, or launch noise.

export const SCHEMA_VERSION = 1 as const;

export const EXIT_SUCCESS = 0;
export const EXIT_OPERATIONAL_ERROR = 1;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_INTERRUPTED = 130;

export function printJsonLine(obj: object): void {
  process.stdout.write(`${JSON.stringify({ schema_version: SCHEMA_VERSION, ...obj })}\n`);
}

export interface ErrorPayload {
  status: "error";
  code: string;
  message: string;
  action?: string;
}

export function errorPayload(code: string, message: string, action?: string): ErrorPayload {
  return action ? { status: "error", code, message, action } : { status: "error", code, message };
}

// utils/json-output.ts — machine output contract for --json mode
//
// All machine output uses schema_version: 1. Every --json invocation writes
// exactly one JSON object to stdout, except `auth login` which is JSONL
// (one line per event). stdout carries JSON only in --json mode — no ANSI,
// progress text, or browser-launch noise; human-readable errors go to stderr.

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

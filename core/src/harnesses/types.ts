import type { RunnerManifest } from "../run-manifest";

export interface HarnessModel {
  /** Goes to the harness CLI as its model name. Null leaves the choice to the harness's own setting. */
  alias: string | null;
  label: string;
}

/** One choice in a session's mode menu. `value` goes to the host. */
export interface HarnessModeOption {
  value: string;
  label: string;
  description: string;
}

/** The modes a running session can be switched between. Empty lists mean the harness has none. */
export interface HarnessModes {
  /** Claude: its four permission modes. Codex: its collaboration mode. In menu order, which is also the Shift+Tab order. */
  permission: ReadonlyArray<HarnessModeOption>;
  /** Codex only: how often it asks before acting. */
  approval: ReadonlyArray<HarnessModeOption>;
}

export interface HarnessDefinition {
  id: string;
  label: string;
  models: ReadonlyArray<HarnessModel>;
  capabilities: { terminal: boolean; approvals: boolean; steer: boolean };
  modes: HarnessModes;
  /** The CLI release the host was tested with: this major and minor. */
  testedVersion: { major: number; minor: number };
  /** The built-in tools a cloud run starts with, before a person adds any. */
  cloudStartingTools: ReadonlyArray<string>;
  /** How a cloud routine runs this harness. Empty when routines do not support it yet. */
  routineModes: ReadonlyArray<"print" | "exec">;
  /** Where a person installs the harness's CLI. */
  installUrl?: string;
}

/**
 * What the backend needs to know about one harness's login, as plain data and pure functions.
 * The backend does the database and key work; it never learns a harness's file format.
 */
export interface CredentialRules {
  /** The `credentials.provider` value the login is stored under. */
  provider: string;
  /** What the login is called in errors, for example "Codex login". */
  label: string;
  /** The text to store for a login a person or a run sent in, or null when it cannot run a routine. */
  validate(value: unknown): string | null;
  /** Whether the harness changed the login during a run, so the new copy must be kept. */
  changedDuringRun(before: string, after: string): boolean;
  /** Set when two runs must not use the login at once. */
  lease: { ttl: string } | null;
}

export type FailureCategory = "none" | "auth" | "rate_limit" | "permission" | "network" | "other";

export type RunnerFailureCode =
  | "timeout"
  | "output_too_large"
  | "claude_error"
  | "claude_exit"
  | "codex_error"
  | "codex_exit"
  | "incomplete_result"
  | "bundle_fetch_failed"
  | "runner_error";

/** The command that starts a harness, and the environment it gets. The environment is built from nothing, never copied. */
export interface HarnessCommand {
  argv: string[];
  stdin: string | null;
  cwd: string;
  env: Record<string, string>;
}

export interface StructuredResult {
  is_error?: boolean;
  result?: unknown;
  [key: string]: unknown;
}

/** How a harness's output holds one structured result. Only some harnesses can give one. */
export interface StructuredReader {
  /** The final result in the output so far, or null while it is not complete. */
  completed(stdout: string): StructuredResult | null;
  /** The structured payload in that result, or null when it holds none. */
  payload(result: StructuredResult | null): unknown | null;
  /** The failure the result itself shows, or the category already seen. */
  failureOf(result: StructuredResult | null, current: FailureCategory): FailureCategory;
  /** Every output line that parses, in order. */
  transcript(stdout: string): unknown[];
}

/** What the sandbox runner needs from a harness. The runner itself does not know any one harness. */
export interface RunnerSide {
  command(manifest: RunnerManifest, prompt: string, schemaText: string | null, env: NodeJS.ProcessEnv): HarnessCommand;
  /** Puts on disk what the harness needs before it starts. */
  prepare(manifest: RunnerManifest, env: NodeJS.ProcessEnv): void;
  logNames: { started: string; finished: string };
  startedFields(manifest: RunnerManifest): Record<string, unknown>;
  /** The failure code for a result that says error, and for a bad exit. */
  failureCodes: { error: RunnerFailureCode; exit: RunnerFailureCode };
  /** The result the harness prints as one output line, or null when the line is not the result. */
  resultOfLine(raw: string): { is_error?: boolean; subtype?: string } | null;
  /** The login the harness may have refreshed during the run, or undefined. */
  refreshedLogin(): string | undefined;
  /** Null when the harness cannot give one structured result. */
  structured: StructuredReader | null;
}

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

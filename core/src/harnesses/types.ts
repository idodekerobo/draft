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

/** Changes Claude's model and effort in a running pane by typing its own slash commands, and checks the screen for the result. */

export interface AgentSwitchDeps {
  capture(): Promise<string>;
  paste(text: string): Promise<void>;
  pressEnter(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export type SlashResult = { ok: true } | { ok: false; note: string };

const POLLS = 25;
const POLL_MS = 150;
const SUCCESS = /Set model to |Set effort level to |Effort level set to /;
const FAILURE = /Invalid argument|Unknown model|Unknown command|not available|isn't available/i;
/** With history, a model switch asks first because the cached conversation is read again. Option 1 is the switch. */
const SWITCH_DIALOG = /Switch model\?/;

/** What the pane printed after the last time `command` was typed, or all of it when the line is not there. */
export function outputAfter(screen: string, command: string): string {
  const lines = screen.split("\n");
  const at = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimStart()).findLastIndex((line) => line.startsWith(`❯ ${command}`));
  return (at === -1 ? lines : lines.slice(at + 1)).join("\n");
}

/** Types one slash command. A "Switch model?" dialog is answered with Enter, and only when it is on screen. */
export async function runSlashCommand(command: string, deps: AgentSwitchDeps): Promise<SlashResult> {
  await deps.paste(command);
  await deps.pressEnter();
  let confirmed = false;
  for (let poll = 0; poll < POLLS; poll += 1) {
    await deps.sleep(POLL_MS);
    const out = outputAfter(await deps.capture(), command);
    if (SUCCESS.test(out)) return { ok: true };
    if (FAILURE.test(out)) return { ok: false, note: `Claude did not accept ${command}.` };
    if (!confirmed && SWITCH_DIALOG.test(out)) {
      confirmed = true;
      await deps.pressEnter();
    }
  }
  return { ok: false, note: `Claude did not confirm ${command}, so it may not have changed.` };
}

export interface ClaudeAgentChange {
  /** The alias to switch to, or null to leave the model as it is. */
  model: string | null;
  /** A level, or "auto" for the model's own. Null leaves the effort as it is. */
  effort: string | null;
}

/** Model first, because a model switch can bring that model's own saved effort. Stops at the first failure. */
export async function switchClaudeAgent(change: ClaudeAgentChange, deps: AgentSwitchDeps): Promise<SlashResult> {
  if (change.model) {
    const result = await runSlashCommand(`/model ${change.model}`, deps);
    if (!result.ok) return result;
  }
  if (change.effort) return runSlashCommand(`/effort ${change.effort}`, deps);
  return { ok: true };
}

import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { shellQuote } from "./launch";

export const HOST_DIR = `${process.env.HOME}/.draft/host`;
const PERMISSION_TIMEOUT_SECONDS = 3600;
const STOP_TIMEOUT_SECONDS = 30;
const SESSION_START_TIMEOUT_SECONDS = 30;

/**
 * Calls the host's local server, which writes its port and token next to this script when it starts.
 * Any failure exits non-zero, so Claude falls back to its own dialog.
 */
export function hookScript(): string {
  return `#!/bin/sh
dir="$HOME/.draft/host"
port=$(cat "$dir/hooks.port" 2>/dev/null) || exit 1
token=$(cat "$dir/hooks.token" 2>/dev/null) || exit 1
exec curl -sS --fail --max-time 3700 -X POST -H "x-draft-token: $token" --data-binary @- "http://127.0.0.1:$port/hook/$1/$2"
`;
}

export function hookSettings(scriptPath: string, sessionId: string) {
  const command = (event: string, timeout: number) => ({
    hooks: [{ type: "command", command: `${shellQuote(scriptPath)} ${shellQuote(sessionId)} ${event}`, timeout }],
  });
  return {
    hooks: {
      PermissionRequest: [command("permission", PERMISSION_TIMEOUT_SECONDS)],
      Stop: [command("stop", STOP_TIMEOUT_SECONDS)],
      SessionStart: [command("session-start", SESSION_START_TIMEOUT_SECONDS)],
    },
  };
}

/** Writes the hook script and a settings file for one session. Returns the settings path for `claude --settings`. */
export function writeSessionSettings(sessionId: string, dir = HOST_DIR): string {
  mkdirSync(`${dir}/settings`, { recursive: true });
  const scriptPath = `${dir}/hook.sh`;
  writeFileSync(scriptPath, hookScript());
  chmodSync(scriptPath, 0o755);
  const settingsPath = `${dir}/settings/${sessionId}.json`;
  writeFileSync(settingsPath, JSON.stringify(hookSettings(scriptPath, sessionId)));
  return settingsPath;
}

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export function defaultBackgroundDir(): string { return join(homedir(), '.draft', 'background'); }
export function activeProfile(): string {
  try { return readFileSync(join(homedir(), '.draft', 'active-profile'), 'utf8').trim() || 'default'; }
  catch { return 'default'; }
}
export function workspacePath(profile: string): string { return join(homedir(), '.draft', 'workspaces', profile); }

// Spawns the real CLI entrypoint as a subprocess against a temp HOME and a
// mock backend, with stdin closed — matching how a released binary runs.

import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { capture, type CaptureResult } from "draft-core/exec";
import type { AuthState } from "draft-core/auth-state";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "index.ts");

export function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "draft-cli-home-"));
}

export function seedCliAuth(home: string, overrides: Partial<AuthState> = {}): void {
  const dir = join(home, ".draft", "personal");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const state: AuthState = {
    access_token: "seed-at",
    refresh_token: "seed-rt",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    organization_id: null,
    team_id: null,
    workspace_id: "ws-1",
    identity_resolved: true,
    onboarding_completed_at: null,
    ...overrides,
  };
  writeFileSync(join(dir, "cli-auth.json"), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export interface RunCliOptions {
  home: string;
  apiUrl: string;
  supabaseUrl?: string;
  timeoutMs?: number;
  cwd?: string;
  stdin?: string;
  env?: Record<string, string>;
}

export function runCli(args: string[], opts: RunCliOptions): Promise<CaptureResult> {
  return capture(["bun", "run", CLI_ENTRY, ...args], {
    timeoutMs: opts.timeoutMs ?? 10_000,
    cwd: opts.cwd,
    stdin: opts.stdin,
    env: {
      HOME: opts.home,
      DRAFT_API_BASE_URL: opts.apiUrl,
      DRAFT_APP_URL: opts.apiUrl,
      DRAFT_SUPABASE_URL: opts.supabaseUrl ?? opts.apiUrl,
      DRAFT_SUPABASE_PUBLISHABLE_KEY: "test-anon-key",
      ...opts.env,
    },
  });
}

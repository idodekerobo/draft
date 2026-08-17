// commands/auth.ts — draft auth login|logout|whoami

import { pairDevice, DevicePairingError } from "draft-core/device-pairing";
import { clearCliAuthState, readCliAuthState, writeCliAuthState, type AuthState } from "draft-core/auth-state";
import { refreshIdentity } from "../cloud-client.ts";
import { getCliRuntimeConfig } from "../runtime-config.ts";
import { EXIT_INTERRUPTED, EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { dim, red } from "../utils/output.ts";

function parseFlags(args: string[], allowed: Set<string>): { flags: Set<string>; error?: string } {
  const flags = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) return { flags, error: `unexpected argument: ${arg}` };
    const name = arg.slice(2);
    if (!allowed.has(name)) return { flags, error: `unknown flag: --${name}` };
    flags.add(name);
  }
  return { flags };
}

function attemptOpenBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? ["open", url] : platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch { /* best-effort only — the URL is always printed regardless */ }
}

function identityFields(identity: { organization_id: string | null; team_id: string | null; workspace_id: string | null; onboarding_completed_at: string | null }) {
  return {
    organization_id: identity.organization_id,
    team_id: identity.team_id,
    workspace_id: identity.workspace_id,
    onboarding_completed_at: identity.onboarding_completed_at,
  };
}

export async function runAuthLogin(args: string[]): Promise<number> {
  const { flags, error } = parseFlags(args, new Set(["force", "json"]));
  const json = flags.has("json");
  if (error) {
    if (json) printJsonLine(errorPayload("invalid_usage", error));
    else console.error(red(`draft auth login: ${error}`));
    return EXIT_USAGE_ERROR;
  }
  const force = flags.has("force");

  let config;
  try {
    config = getCliRuntimeConfig();
  } catch (e) {
    const message = e instanceof Error ? e.message : "configuration_unavailable";
    if (json) printJsonLine(errorPayload("configuration_unavailable", message));
    else console.error(red(`draft auth login: ${message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  // Session reuse: if credentials exist and the caller didn't force a new
  // pairing, try a live whoami before ever starting device pairing.
  if (!force && readCliAuthState()) {
    const result = await refreshIdentity();
    if (result.ok) {
      if (json) printJsonLine({ status: "authenticated", ...identityFields(result.identity) });
      else console.log(`Already signed in.${result.identity.workspace_id ? ` Workspace: ${result.identity.workspace_id}` : " (no workspace yet — finish onboarding in the Draft app)"}`);
      return EXIT_SUCCESS;
    }
    if (result.code === "session_refresh_transient" || result.code === "auth_busy") {
      if (json) printJsonLine(errorPayload(result.code, "Could not verify the existing session right now. Retry shortly."));
      else console.error(red(`draft auth login: ${result.code} — retry shortly`));
      return EXIT_OPERATIONAL_ERROR;
    }
    // not_authenticated / whoami_failed: the stored session is dead — fall
    // through and start a fresh pairing flow below.
  }

  const controller = new AbortController();
  let interrupted = false;
  const onSignal = () => { interrupted = true; controller.abort(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const tokens = await pairDevice({
      apiUrl: config.apiBaseUrl,
      appUrl: config.appUrl,
      fetch,
      signal: controller.signal,
      onUrl: (url) => {
        if (json) printJsonLine({ status: "pairing_required", url });
        else {
          console.log(`Open this URL to sign in: ${url}`);
          attemptOpenBrowser(url);
        }
      },
      onProgress: () => { /* human progress noise stays out of --json; the URL line is enough for both modes */ },
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    const authState: AuthState = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at ?? nowSeconds + 3600,
      organization_id: null,
      team_id: null,
      workspace_id: null,
      identity_resolved: false,
      onboarding_completed_at: null,
    };
    writeCliAuthState(authState);

    const identityResult = await refreshIdentity();
    if (!identityResult.ok) {
      // Tokens are already persisted — a later whoami/context call retries hydration.
      if (json) printJsonLine(errorPayload(identityResult.code, "Signed in, but could not hydrate account details yet."));
      else console.error(dim("Signed in, but account details are still syncing — try again in a moment."));
      return EXIT_OPERATIONAL_ERROR;
    }

    if (json) printJsonLine({ status: "authenticated", ...identityFields(identityResult.identity) });
    else console.log(`Signed in.${identityResult.identity.workspace_id ? ` Workspace: ${identityResult.identity.workspace_id}` : " (no workspace yet — finish onboarding in the Draft app)"}`);
    return EXIT_SUCCESS;
  } catch (e) {
    if (interrupted) {
      if (json) printJsonLine({ status: "error", code: "interrupted", message: "Sign-in was interrupted." });
      else console.error(red("Sign-in interrupted."));
      return EXIT_INTERRUPTED;
    }
    const kind = e instanceof DevicePairingError ? e.kind : "pairing_failed";
    if (json) printJsonLine(errorPayload(kind, `Sign-in failed: ${kind}`));
    else console.error(red(`draft auth login: ${kind}`));
    return EXIT_OPERATIONAL_ERROR;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export async function runAuthWhoami(args: string[]): Promise<number> {
  const { flags, error } = parseFlags(args, new Set(["json"]));
  const json = flags.has("json");
  if (error) {
    if (json) printJsonLine(errorPayload("invalid_usage", error));
    else console.error(red(`draft auth whoami: ${error}`));
    return EXIT_USAGE_ERROR;
  }

  const result = await refreshIdentity();
  if (!result.ok) {
    const action = result.code === "not_authenticated" ? "draft auth login" : undefined;
    if (json) printJsonLine(errorPayload(result.code, "Not signed in or session could not be verified.", action));
    else console.error(red(`draft auth whoami: ${result.code}${action ? ` — run \`${action}\`` : ""}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  if (json) printJsonLine(identityFields(result.identity));
  else {
    console.log(`organization_id: ${result.identity.organization_id ?? "-"}`);
    console.log(`team_id: ${result.identity.team_id ?? "-"}`);
    console.log(`workspace_id: ${result.identity.workspace_id ?? "-"}`);
  }
  return EXIT_SUCCESS;
}

export async function runAuthLogout(args: string[]): Promise<number> {
  const { flags, error } = parseFlags(args, new Set(["json"]));
  const json = flags.has("json");
  if (error) {
    if (json) printJsonLine(errorPayload("invalid_usage", error));
    else console.error(red(`draft auth logout: ${error}`));
    return EXIT_USAGE_ERROR;
  }

  const state = readCliAuthState();
  let revokeFailed = false;
  if (state) {
    try {
      const config = getCliRuntimeConfig();
      const response = await fetch(`${config.supabaseUrl}/auth/v1/logout?scope=local`, {
        method: "POST",
        headers: { apikey: config.supabasePublishableKey, Authorization: `Bearer ${state.access_token}` },
      });
      if (!response.ok && response.status !== 401) revokeFailed = true;
    } catch {
      revokeFailed = true;
    } finally {
      clearCliAuthState();
    }
  }

  if (revokeFailed) {
    if (json) printJsonLine({ status: "partial_logout", code: "partial_logout" });
    else console.error(red("Signed out locally, but the remote session could not be revoked. It may still be valid."));
    return EXIT_OPERATIONAL_ERROR;
  }

  if (json) printJsonLine({ status: "logged_out" });
  else console.log("Signed out.");
  return EXIT_SUCCESS;
}

export async function runAuth(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "login": return runAuthLogin(rest);
    case "logout": return runAuthLogout(rest);
    case "whoami": return runAuthWhoami(rest);
    default:
      console.error(red(`draft auth: unknown subcommand${sub ? ` "${sub}"` : ""}. Use login, logout, or whoami.`));
      return EXIT_USAGE_ERROR;
  }
}

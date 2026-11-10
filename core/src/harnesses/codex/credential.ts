import type { CredentialRules } from "../types";

const AUTH_JSON_MAX_BYTES = 64 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * The text of a Codex `auth.json` that can run a routine, or null. A ChatGPT login needs a refresh token,
 * because Codex renews the login by itself. An API key works too, so a workspace can use one instead.
 */
export function parseCodexAuthJson(value: unknown): string | null {
  if (typeof value !== "string" || Buffer.byteLength(value) > AUTH_JSON_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  if (parsed.auth_mode === "chatgpt") return isObject(parsed.tokens) && isText(parsed.tokens.refresh_token) ? value : null;
  if (parsed.auth_mode === "apikey") return isText(parsed.OPENAI_API_KEY) ? value : null;
  return null;
}

/** Whether Codex changed the login during a run. A refresh moves `last_refresh`, and the old refresh token stops working. */
export function authJsonChanged(before: string, after: string): boolean {
  try {
    const [a, b] = [JSON.parse(before), JSON.parse(after)] as Array<Record<string, unknown>>;
    return a.last_refresh !== b.last_refresh || JSON.stringify(a.tokens) !== JSON.stringify(b.tokens);
  } catch {
    return false;
  }
}

/** A refresh token must not be used by two runs at once, so a run holds the login's lease. */
export const codexCredentialRules: CredentialRules = {
  provider: "codex_chatgpt_auth",
  label: "Codex login",
  validate: parseCodexAuthJson,
  changedDuringRun: authJsonChanged,
  lease: { ttl: "20 minutes" },
};

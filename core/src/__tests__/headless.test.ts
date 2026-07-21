import { describe, it, expect, mock } from "bun:test";

// Mock exec BEFORE importing headless — Bun evaluates mock.module synchronously
// before the first import of the mocked path.
let mockCaptureImpl: () => Promise<{ exitCode: number; stdout: string; stderr: string }>;

mock.module("../exec", () => ({
  capture: (..._args: unknown[]) => mockCaptureImpl(),
  spawn:   (..._args: unknown[]) => Promise.resolve(0),
}));

const { classifyOutput, isClaudeAuthenticated } = await import("../agents/headless");

// ── real stdout fixtures pulled from context-bootstrap-*.log failures ──────────
const NOT_LOGGED_IN = "Not logged in · Please run /login";
const EXPIRED_TOKEN = "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.";
const INVALID_CREDS = "Failed to authenticate. API Error: 401 Invalid authentication credentials";

describe("classifyOutput", () => {
  it("classifies 'not logged in' stdout as an auth error, not the generic fallback", () => {
    // Before the fix, this text lived in stdout and classifyStderr(stderr) only
    // ever saw stderr — which was empty in all three real failures — so this
    // always fell through to the generic "Something went wrong" message.
    expect(classifyOutput(NOT_LOGGED_IN)).toBe(
      "You're not signed in to Claude Code. Open a terminal, run `claude`, then `/login` to sign in — then retry context setup."
    );
  });

  it("classifies an expired OAuth token 401 as an auth error", () => {
    expect(classifyOutput(EXPIRED_TOKEN)).toContain("not signed in to Claude Code");
  });

  it("classifies invalid credentials 401 as an auth error", () => {
    expect(classifyOutput(INVALID_CREDS)).toContain("not signed in to Claude Code");
  });

  it("still falls back to the generic message for unrecognized errors", () => {
    expect(classifyOutput("some completely unrelated crash")).toBe(
      "Something went wrong. You can retry or set up context manually."
    );
  });
});

describe("isClaudeAuthenticated", () => {
  it("returns false when the keychain lookup fails (never logged in)", async () => {
    mockCaptureImpl = async () => ({ exitCode: 1, stdout: "", stderr: "not found" });
    expect(await isClaudeAuthenticated()).toBe(false);
  });

  it("returns true when the keychain entry exists", async () => {
    mockCaptureImpl = async () => ({ exitCode: 0, stdout: "password", stderr: "" });
    expect(await isClaudeAuthenticated()).toBe(true);
  });
});

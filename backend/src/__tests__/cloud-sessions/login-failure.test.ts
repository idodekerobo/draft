import { describe, expect, it } from "bun:test";
import { claudeLoginFailed } from "../../cloud-sessions/login-failure";

const line = (value: unknown) => ({ stream: "root.jsonl", position: 0, raw: JSON.stringify(value) });

// The first entry is what Claude Code wrote for a bad token, captured from a real run.
const REAL = { type: "assistant", isApiErrorMessage: true, error: "authentication_failed", message: { model: "<synthetic>", content: [{ type: "text", text: "Failed to authenticate. API Error: 401 OAuth access token is invalid." }] } };

describe("a Claude login failure in transcript lines", () => {
  it("is found in the message Claude writes for a login that no longer works", () => {
    expect(claudeLoginFailed([line({ type: "user", message: { content: "hi" } }), line(REAL)])).toBe(true);
  });

  it("is not found in ordinary text about logging in, from the model or a person", () => {
    expect(claudeLoginFailed([line({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "Failed to authenticate. Please run /login." }] } })])).toBe(false);
    expect(claudeLoginFailed([line({ type: "user", message: { content: "my token says authentication_failed" } })])).toBe(false);
  });

  it("is not found in another kind of API error, or in a line that is not JSON or is too large to read", () => {
    expect(claudeLoginFailed([line({ ...REAL, error: "rate_limit" })])).toBe(false);
    expect(claudeLoginFailed([{ stream: "root.jsonl", position: 1, raw: "authentication_failed {" }, { stream: "root.jsonl", position: 2, oversizeBytes: 9 }])).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { readSecrets, readCollaboration } from "../utils/config.ts";

const TMP = `/tmp/draft-test-${Date.now()}`;

beforeEach(() => mkdirSync(join(TMP, "config"), { recursive: true }));
afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("readSecrets", () => {
  it("returns ok:true for valid JSON", () => {
    writeFileSync(
      join(TMP, "config", "secrets.json"),
      JSON.stringify({ granola_mode: "mcp", slack_bot_token: "xoxb-test" })
    );
    const result = readSecrets(TMP);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.secrets.granola_mode).toBe("mcp");
      expect(result.secrets.slack_bot_token).toBe("xoxb-test");
    }
  });

  it("returns ok:false reason:missing when file does not exist", () => {
    const result = readSecrets(TMP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });

  it("returns ok:false reason:malformed for invalid JSON", () => {
    writeFileSync(join(TMP, "config", "secrets.json"), "not json {{{");
    const result = readSecrets(TMP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  it("returns ok:true with empty object for missing keys (all keys optional)", () => {
    writeFileSync(join(TMP, "config", "secrets.json"), "{}");
    const result = readSecrets(TMP);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.secrets.granola_mode).toBeUndefined();
      expect(result.secrets.slack_bot_token).toBeUndefined();
      expect(result.secrets.github_connected).toBeUndefined();
    }
  });
});

describe("readCollaboration", () => {
  it("returns ok:true for valid collab config", () => {
    writeFileSync(
      join(TMP, "config", "collaboration.json"),
      JSON.stringify({ mode: "github", team_repo_url: "https://github.com/org/repo" })
    );
    const result = readCollaboration(TMP);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.collab.mode).toBe("github");
  });

  it("returns ok:false reason:missing when file absent", () => {
    const result = readCollaboration(TMP);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing");
  });
});

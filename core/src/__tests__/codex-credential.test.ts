import { describe, expect, it } from "bun:test";
import { authJsonChanged, parseCodexAuthJson } from "../harnesses/codex/credential";

const chatgpt = (refresh = "r1", lastRefresh = "2026-10-30T00:00:00Z") =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: lastRefresh, tokens: { access_token: "a", refresh_token: refresh } });

describe("parseCodexAuthJson", () => {
  it("accepts a ChatGPT login with a refresh token and an API key login", () => {
    expect(parseCodexAuthJson(chatgpt())).toBe(chatgpt());
    const apiKey = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" });
    expect(parseCodexAuthJson(apiKey)).toBe(apiKey);
  });

  it("rejects what cannot run a routine", () => {
    expect(parseCodexAuthJson(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a" } }))).toBeNull();
    expect(parseCodexAuthJson(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: " " }))).toBeNull();
    expect(parseCodexAuthJson(JSON.stringify({ auth_mode: "other" }))).toBeNull();
    expect(parseCodexAuthJson("not json")).toBeNull();
    expect(parseCodexAuthJson("[]")).toBeNull();
    expect(parseCodexAuthJson(42)).toBeNull();
    expect(parseCodexAuthJson(chatgpt("x".repeat(70_000)))).toBeNull();
  });
});

describe("authJsonChanged", () => {
  it("sees a refresh and ignores an untouched file or one it cannot read", () => {
    expect(authJsonChanged(chatgpt("r1", "t1"), chatgpt("r2", "t2"))).toBe(true);
    expect(authJsonChanged(chatgpt("r1", "t1"), chatgpt("r1", "t1"))).toBe(false);
    expect(authJsonChanged(chatgpt(), "not json")).toBe(false);
  });
});

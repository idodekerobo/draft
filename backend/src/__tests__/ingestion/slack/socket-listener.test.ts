import { describe, expect, it } from "bun:test";
import {
  SlackSocketOpenError,
  classifySlackListenerFailure,
  nextReconnectDelay,
} from "../../../ingestion/slack/socket-listener";

// Only the pure backoff step is unit-tested here; a full WebSocket lifecycle
// isn't practically mockable in this test environment.

describe("nextReconnectDelay", () => {
  it("doubles the delay", () => {
    expect(nextReconnectDelay(1_000)).toBe(2_000);
    expect(nextReconnectDelay(2_000)).toBe(4_000);
    expect(nextReconnectDelay(30_000)).toBe(60_000);
  });

  it("caps at the max delay", () => {
    expect(nextReconnectDelay(250_000)).toBe(300_000);
    expect(nextReconnectDelay(300_000)).toBe(300_000);
    expect(nextReconnectDelay(1_000_000)).toBe(300_000);
  });

  it("respects a custom max", () => {
    expect(nextReconnectDelay(8_000, 10_000)).toBe(10_000);
    expect(nextReconnectDelay(4_000, 10_000)).toBe(8_000);
  });
});

describe("classifySlackListenerFailure", () => {
  it("does not retry terminal Slack authentication failures", () => {
    expect(classifySlackListenerFailure(new SlackSocketOpenError("invalid_auth"))).toEqual({
      retryable: false,
      connectionStatus: "revoked",
    });
    expect(classifySlackListenerFailure(new SlackSocketOpenError("token_revoked")).retryable).toBe(false);
  });

  it("retries transient Slack and network failures", () => {
    expect(classifySlackListenerFailure(new SlackSocketOpenError("internal_error"))).toEqual({
      retryable: true,
    });
    expect(classifySlackListenerFailure(new TypeError("fetch failed"))).toEqual({ retryable: true });
  });
});

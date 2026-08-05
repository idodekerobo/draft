import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SLACK_BATCH_LIMITS,
  loadSlackBatchLimits,
  loadSlackListenerConfig,
} from "../../../ingestion/slack/config";

describe("loadSlackBatchLimits", () => {
  it("falls back to defaults when no env vars are set", () => {
    expect(loadSlackBatchLimits({})).toEqual(DEFAULT_SLACK_BATCH_LIMITS);
  });

  it("applies env overrides per field", () => {
    const limits = loadSlackBatchLimits({
      SLACK_BATCH_MAX_SPAN_HOURS: "6",
      SLACK_BATCH_MAX_MESSAGES: "50",
      SLACK_BATCH_MAX_CONTENT_BYTES: "20000",
    });
    expect(limits).toEqual({
      maxSpanMs: 6 * 3_600_000,
      maxMessageCount: 50,
      maxContentBytes: 20_000,
    });
  });

  it("throws on a non-positive override", () => {
    expect(() => loadSlackBatchLimits({ SLACK_BATCH_MAX_MESSAGES: "0" })).toThrow();
    expect(() => loadSlackBatchLimits({ SLACK_BATCH_MAX_MESSAGES: "-5" })).toThrow();
    expect(() => loadSlackBatchLimits({ SLACK_BATCH_MAX_MESSAGES: "abc" })).toThrow();
  });
});

describe("loadSlackListenerConfig", () => {
  it("loads a valid HTTPS base URL", () => {
    const config = loadSlackListenerConfig({ DRAFT_API_BASE_URL: "https://example.com" });
    expect(config).toEqual({ draftApiBaseUrl: "https://example.com" });
  });

  it("throws when DRAFT_API_BASE_URL is missing", () => {
    expect(() => loadSlackListenerConfig({})).toThrow();
  });

  it("throws when DRAFT_API_BASE_URL is not HTTPS", () => {
    expect(() => loadSlackListenerConfig({ DRAFT_API_BASE_URL: "http://example.com" })).toThrow();
  });

  it("throws when DRAFT_API_BASE_URL is not a valid URL", () => {
    expect(() => loadSlackListenerConfig({ DRAFT_API_BASE_URL: "not-a-url" })).toThrow();
  });
});

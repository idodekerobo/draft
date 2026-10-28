import { describe, expect, it } from "bun:test";
import { formatMessageTime, messageUrl, parseMessageParam, sessionUrl } from "./share-links";

describe("share links", () => {
  it("builds a session url and drops a trailing slash from the base", () => {
    expect(sessionUrl("https://app.draftai.us/", "abc")).toBe("https://app.draftai.us/sessions/abc");
  });

  it("builds a message url that parses back to the same seq", () => {
    const url = messageUrl("https://app.draftai.us", "abc", 42);
    expect(url).toBe("https://app.draftai.us/sessions/abc?m=42");
    expect(parseMessageParam(new URL(url).searchParams.get("m"))).toBe(42);
  });

  it("ignores values that are not message numbers", () => {
    expect(parseMessageParam(null)).toBeNull();
    expect(parseMessageParam("")).toBeNull();
    expect(parseMessageParam("1x")).toBeNull();
    expect(parseMessageParam("-3")).toBeNull();
  });

  it("formats a time as month, day and a lowercase 12-hour time", () => {
    const iso = new Date(2026, 9, 28, 17, 27).toISOString();
    expect(formatMessageTime(iso, "en-US")).toBe("Oct 28, 5:27 pm");
  });

  it("returns an empty string for a bad date", () => {
    expect(formatMessageTime("not a date")).toBe("");
  });
});

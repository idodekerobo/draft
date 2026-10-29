import { describe, expect, it } from "bun:test";
import { HOST_FATAL_CODES, deliveredText, hostErrorAction, normalizeInputText, presenceNames, splitAuthor, stripPasteWrapper } from "../live-sessions";

describe("author tag", () => {
  it("round-trips through deliveredText and splitAuthor", () => {
    expect(splitAuthor(deliveredText("Priya", "run the tests"))).toEqual({ text: "run the tests", author: "Priya" });
  });

  it("leaves a typed prompt alone", () => {
    expect(splitAuthor("fix the login bug")).toEqual({ text: "fix the login bug", author: null });
  });

  it("cleans a name that could break the tag", () => {
    expect(deliveredText("A]\u001b[B", "hi")).toBe("[A B via Draft] hi");
    expect(deliveredText("   ", "hi")).toBe("[A teammate via Draft] hi");
    expect(deliveredText("x".repeat(100), "hi")).toBe(`[${"x".repeat(60)} via Draft] hi`);
  });

  it("drops whitespace after the tag", () => {
    expect(splitAuthor("[Dev via Draft]   hello").text).toBe("hello");
  });
});

describe("stripPasteWrapper", () => {
  const tagged = "[Dev via Draft] - one\n- two";

  it("unwraps the form Claude Code records, with the id on the closing tag", () => {
    const raw = `\n\n<pasted_content id="1177">\n${tagged}\n</pasted_content id="1177">\n`;
    expect(stripPasteWrapper(raw)).toBe(tagged);
    expect(splitAuthor(stripPasteWrapper(raw))).toEqual({ text: "- one\n- two", author: "Dev" });
  });

  it("accepts a closing tag without an id", () => {
    expect(stripPasteWrapper(`<pasted_content id="2">\nhi\n</pasted_content>`)).toBe("hi");
  });

  it("keeps text around a block and unwraps several blocks", () => {
    expect(stripPasteWrapper(`before <pasted_content id="1">\na\n</pasted_content id="1"> and <pasted_content id="2">\nb\n</pasted_content id="2"> after`)).toBe("before a and b after");
  });

  it("leaves plain text and an unclosed tag alone", () => {
    expect(stripPasteWrapper("fix the bug")).toBe("fix the bug");
    expect(stripPasteWrapper('<pasted_content id="1">\nno end')).toBe('<pasted_content id="1">\nno end');
  });
});

describe("normalizeInputText", () => {
  it("keeps line breaks and tabs, and removes characters that could end a paste early", () => {
    expect(normalizeInputText("a\u001b[201~ ls\u0000\r\nb\tc")).toBe("a[201~ ls\nb\tc");
  });
});

describe("HOST_FATAL_CODES", () => {
  it("stops a host for an ended or foreign session and not for a full queue", () => {
    expect(HOST_FATAL_CODES.has("session_ended")).toBe(true);
    expect(HOST_FATAL_CODES.has("queue_full")).toBe(false);
  });
});

describe("presenceNames", () => {
  it("lists the other people once each, sorted, and never the viewer", () => {
    const state = { u1: [{ name: "Priya" }, { name: "Priya" }], u2: [{ name: "Dev" }], me: [{ name: "Maya" }] };
    expect(presenceNames(state, "me")).toEqual(["Dev", "Priya"]);
  });

  it("skips someone without a name", () => {
    expect(presenceNames({ u1: [{}], u2: [{ name: "  " }], u3: [{ name: "Sam" }] }, "me")).toEqual(["Sam"]);
    expect(presenceNames({}, "me")).toEqual([]);
  });
});

describe("hostErrorAction", () => {
  it("stops for an ended or foreign session, pauses for another environment or account, and retries the rest", () => {
    expect(hostErrorAction("session_ended")).toBe("stop");
    expect(hostErrorAction("foreign_host")).toBe("stop");
    expect(hostErrorAction("not_found")).toBe("pause");
    expect(hostErrorAction("forbidden")).toBe("pause");
    expect(hostErrorAction("request_failed_500")).toBe("retry");
    expect(hostErrorAction("heartbeat_failed")).toBe("retry");
  });
});

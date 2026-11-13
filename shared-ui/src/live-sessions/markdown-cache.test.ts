import { describe, expect, it } from "bun:test";
import { cachedMarkdown } from "./markdown-cache";

describe("cachedMarkdown", () => {
  it("parses the same text once", () => {
    let calls = 0;
    const render = (text: string) => `<p>${text}${++calls}</p>`;
    expect(cachedMarkdown("cache-test one", render)).toBe("<p>cache-test one1</p>");
    expect(cachedMarkdown("cache-test one", render)).toBe("<p>cache-test one1</p>");
    expect(cachedMarkdown("cache-test two", render)).toBe("<p>cache-test two2</p>");
    expect(calls).toBe(2);
  });

  it("forgets the oldest text when it is full", () => {
    let calls = 0;
    const render = (text: string) => `${text}:${++calls}`;
    cachedMarkdown("cache-test oldest", render);
    for (let i = 0; i < 500; i++) cachedMarkdown(`cache-test fill ${i}`, render);
    const before = calls;
    cachedMarkdown("cache-test oldest", render);
    expect(calls).toBe(before + 1);
  });
});

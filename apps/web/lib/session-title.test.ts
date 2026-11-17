import { describe, expect, it } from "bun:test";
import { sessionIdFromNext } from "./session-title";

const ID = "0b9a7a46-6a63-4a53-9a63-0d0c7c6d7a11";

describe("sessionIdFromNext", () => {
  it("reads the id from a session path", () => {
    expect(sessionIdFromNext(`/sessions/${ID}`)).toBe(ID);
    expect(sessionIdFromNext(`/sessions/${ID}?m=4`)).toBe(ID);
  });
  it("ignores other paths", () => {
    expect(sessionIdFromNext("/connections")).toBeNull();
    expect(sessionIdFromNext("/sessions")).toBeNull();
    expect(sessionIdFromNext(undefined)).toBeNull();
  });
});

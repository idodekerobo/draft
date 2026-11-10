import { describe, expect, it } from "bun:test";
import { decodeToolEnvelope } from "../tool-envelope";

describe("decodeToolEnvelope", () => {
  it("gives the output of an ok answer, and marks a conflict as one", () => {
    expect(decodeToolEnvelope({ status: "ok", output: { n: 1 } })).toEqual({ ok: true, output: { n: 1 }, conflict: false });
    expect(decodeToolEnvelope({ status: "conflict", output: { retryable: true } })).toEqual({ ok: true, output: { retryable: true }, conflict: true });
  });

  it("gives a refusal or a denial its code and message", () => {
    expect(decodeToolEnvelope({ status: "refused", code: "skill_not_found", message: "No skill with that name." })).toEqual({
      ok: false, status: "refused", code: "skill_not_found", message: "No skill with that name.",
    });
    expect(decodeToolEnvelope({ status: "denied", code: "not_permitted", message: "This run may not call x" })).toMatchObject({ ok: false, status: "denied", code: "not_permitted" });
  });

  it("joins the issues of invalid input, and passes on an error's message", () => {
    expect(decodeToolEnvelope({ status: "invalid", issues: ["a: required", "b: too long"] })).toEqual({
      ok: false, status: "invalid", code: "invalid_input", message: "a: required; b: too long",
    });
    expect(decodeToolEnvelope({ status: "error", message: "The tool failed." })).toEqual({ ok: false, status: "error", code: "tool_error", message: "The tool failed." });
  });

  it("reads the workspace check's own { error } body as a denial", () => {
    expect(decodeToolEnvelope({ error: "forbidden" })).toEqual({ ok: false, status: "denied", code: "forbidden", message: "forbidden" });
  });

  it("calls anything else malformed and never throws", () => {
    for (const value of [null, undefined, 5, "x", [], {}, { status: "weird" }]) {
      expect(decodeToolEnvelope(value)).toMatchObject({ ok: false, status: "malformed", code: "malformed_response" });
    }
  });

  it("falls back to a default code and message when a refusal has none", () => {
    expect(decodeToolEnvelope({ status: "refused" })).toEqual({ ok: false, status: "refused", code: "refused", message: "refused" });
  });
});

import { describe, expect, it } from "bun:test";
import { isAgentRequest } from "../../observability/is-agent-request";

const request = (headers: Record<string, string> = {}) => new Request("http://internal.test", { headers });

describe("isAgentRequest", () => {
  it("counts a bare bearer-token call, which is what the CLI makes", () => {
    expect(isAgentRequest(request({ authorization: "Bearer token" }))).toBe(true);
  });

  it("does not count a browser call", () => {
    expect(isAgentRequest(request({ origin: "https://app.draftai.us" }))).toBe(false);
  });

  it("does not count the desktop app or the web app's server", () => {
    expect(isAgentRequest(request({ "x-draft-client": "desktop" }))).toBe(false);
    expect(isAgentRequest(request({ "x-draft-client": "web" }))).toBe(false);
  });

  it("still counts a client name it does not know", () => {
    expect(isAgentRequest(request({ "x-draft-client": "cli" }))).toBe(true);
    expect(isAgentRequest(request({ "x-draft-client": "" }))).toBe(true);
  });
});

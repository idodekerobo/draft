import { expect, test } from "bun:test";
import { callSurface, isAgentRequest } from "../../observability/is-agent-request";

test("distinguishes app surfaces while counting only external calls as agent usage", () => {
  for (const [headers, surface] of [
    [{ "x-draft-client": "desktop" }, "desktop_app"],
    [{ "x-draft-client": "web" }, "web_app"],
    [{ origin: "https://draft.example" }, "web_app"],
    [{}, "cli"],
  ] as const) {
    const request = new Request("https://draft.example", { headers });
    expect(callSurface(request)).toBe(surface);
    expect(isAgentRequest(request)).toBe(surface === "cli");
  }
});

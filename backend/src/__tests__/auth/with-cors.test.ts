import { describe, expect, it } from "bun:test";
import { loadConfig } from "../../config";
import { OPTIONS, withCors } from "../../auth/with-cors";

const appOrigin = loadConfig().appUrl;

function preflight(origin: string, method: string): Request {
  return new Request("http://internal.test/workspaces/w/connections", {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": method },
  });
}

describe("withCors", () => {
  it.each(["GET", "POST", "PATCH", "DELETE"])("allows %s preflight from the app origin", async (method) => {
    const response = await OPTIONS(preflight(appOrigin, method));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(appOrigin);
    expect(response.headers.get("access-control-allow-methods")?.split(",")).toContain(method);
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("rejects a disallowed origin", async () => {
    const response = await OPTIONS(preflight("https://evil.example", "GET"));
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("passes requests without an Origin straight through", async () => {
    const handler = withCors(async () => Response.json({ ok: true }));
    const response = await handler(new Request("http://internal.test/x"));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

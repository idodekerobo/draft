import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureHooksServer, hookOutput, registerSessionHooks } from "./hooks-server";

const dir = mkdtempSync(join(tmpdir(), "hooks-server-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
ensureHooksServer(dir);
const port = readFileSync(`${dir}/hooks.port`, "utf8");
const token = readFileSync(`${dir}/hooks.token`, "utf8");

const call = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "x-draft-token": token }, body: "{}", ...init });

describe("hooks server", () => {
  it("answers a permission hook with Claude's hook output format", async () => {
    registerSessionHooks("s1", { permission: async () => ({ behavior: "allow" }), stopped: () => {} });
    const res = await call("/hook/s1/permission");
    expect(await res.json()).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    expect(hookOutput({ behavior: "deny", message: "no" })).toContain('"message":"no"');
  });

  it("gives no output when the host wants Claude's own dialog", async () => {
    registerSessionHooks("s2", { permission: async () => null, stopped: () => {} });
    const res = await call("/hook/s2/permission");
    expect(res.status).toBe(204);
  });

  it("tells the session its connection ended when the hook process goes away", async () => {
    let aborted: () => void;
    const gone = new Promise<void>((done) => (aborted = done));
    registerSessionHooks("s3", {
      permission: (_payload, signal) => new Promise((resolve) => signal.addEventListener("abort", () => (aborted(), resolve(null)))),
      stopped: () => {},
    });
    const controller = new AbortController();
    void call("/hook/s3/permission", { signal: controller.signal }).catch(() => {});
    await new Promise((done) => setTimeout(done, 50));
    controller.abort();
    await gone;
  });

  it("runs the Stop handler and refuses a wrong token, an unknown route and a GET", async () => {
    let stopped = 0;
    registerSessionHooks("s4", { permission: async () => null, stopped: () => void stopped++ });
    expect((await call("/hook/s4/stop")).status).toBe(204);
    expect(stopped).toBe(1);
    expect((await call("/hook/s4/stop", { headers: { "x-draft-token": "wrong" } })).status).toBe(404);
    expect((await call("/hook/s4/other")).status).toBe(404);
    expect((await call("/hook/s4/stop", { method: "GET", body: undefined })).status).toBe(404);
  });

  it("an unregistered session gets no output instead of an error", async () => {
    expect((await call("/hook/nobody/permission")).status).toBe(204);
  });
});

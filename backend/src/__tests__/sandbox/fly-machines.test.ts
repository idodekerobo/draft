import { describe, expect, it } from "bun:test";
import {
  FlyMachinesApiError,
  FlyMachinesClient,
  FlyMachineWaitTimeoutError,
  assertRelativeGuestPath,
} from "../../sandbox/fly-machines";

function machine(id = "machine-1", state = "created"): Response {
  return Response.json({ id, state });
}

describe("FlyMachinesClient", () => {
  it("creates one machine with files present before launch and an exact production request", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new FlyMachinesClient({
      app: "draft/sandboxes",
      token: "fly-secret-token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return machine();
      },
    });

    await client.create({
      image: "registry.fly.io/draft@sha256:abc123",
      files: {
        "input/run.json": '{"run":1}\n',
        "input/context/product/index.md": new TextEncoder().encode("# Product\n"),
      },
      env: { CALLBACK_URL: "https://example.test/callback", RUN_ID: "run-1" },
      region: "iad",
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
      metadata: { run_id: "run-1" },
      name: "sandbox-run-1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.machines.dev/v1/apps/draft%2Fsandboxes/machines",
    );
    expect(calls[0].init?.method).toBe("POST");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer fly-secret-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      name: "sandbox-run-1",
      region: "iad",
      config: {
        image: "registry.fly.io/draft@sha256:abc123",
        env: { CALLBACK_URL: "https://example.test/callback", RUN_ID: "run-1" },
        files: [
          {
            guest_path: "/run/input/context/product/index.md",
            raw_value: Buffer.from("# Product\n").toString("base64"),
          },
          {
            guest_path: "/run/input/run.json",
            raw_value: Buffer.from('{"run":1}\n').toString("base64"),
          },
        ],
        auto_destroy: true,
        restart: { policy: "no" },
        guest: { cpu_kind: "shared", cpus: 1, memory_mb: 512 },
        metadata: { run_id: "run-1" },
      },
    });
  });

  it("rejects unsafe guest paths", () => {
    for (const path of [
      "",
      "/absolute",
      "../escape",
      "input/../escape",
      "input/./file",
      "input//file",
      "input\\file",
      "input/file/",
      "input/evil\0file",
    ]) {
      expect(() => assertRelativeGuestPath(path)).toThrow("safe relative guest path");
    }
    expect(() => assertRelativeGuestPath("input/context/product/index.md")).not.toThrow();
  });

  it("redacts API response bodies and credentials from useful errors", async () => {
    const client = new FlyMachinesClient({
      app: "draft",
      token: "do-not-leak-token",
      fetch: async () =>
        new Response('request echoed do-not-leak-token and super-secret-file', {
          status: 422,
          headers: { "fly-request-id": "request-123" },
        }),
    });

    let error: unknown;
    try {
      await client.create({ image: "image@sha256:123", files: { "secret.txt": "super-secret-file" } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FlyMachinesApiError);
    expect(String(error)).toContain("HTTP 422");
    expect(String(error)).toContain("request-123");
    expect(String(error)).not.toContain("do-not-leak-token");
    expect(String(error)).not.toContain("super-secret-file");
  });

  it("polls until the requested state", async () => {
    const states = ["created", "starting", "started"];
    let now = 0;
    let calls = 0;
    const client = new FlyMachinesClient({
      app: "draft",
      token: "token",
      fetch: async () => machine("machine-1", states[calls++] ?? "started"),
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    const result = await client.waitForState("machine-1", "started", {
      timeoutMs: 1_000,
      pollIntervalMs: 10,
    });
    expect(result.state).toBe("started");
    expect(calls).toBe(3);
  });

  it("times out with the last observed state after a bounded polling window", async () => {
    let now = 0;
    let calls = 0;
    const client = new FlyMachinesClient({
      app: "draft",
      token: "token",
      fetch: async () => {
        calls += 1;
        return machine("machine-1", "starting");
      },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });

    let error: unknown;
    try {
      await client.waitForState("machine-1", "started", {
        timeoutMs: 25,
        pollIntervalMs: 10,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(FlyMachineWaitTimeoutError);
    expect(String(error)).toContain("last state was starting");
    expect(calls).toBe(3);
  });

  it("force-deletes with the encoded machine id", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new FlyMachinesClient({
      app: "draft",
      token: "token",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(null, { status: 204 });
      },
    });

    await client.forceDelete("machine/id");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.machines.dev/v1/apps/draft/machines/machine%2Fid?force=true",
    );
    expect(calls[0].init?.method).toBe("DELETE");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
      "Bearer token",
    );
  });
});

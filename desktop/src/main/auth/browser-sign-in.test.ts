import { describe, expect, mock, test } from "bun:test";
import type { AuthState } from "draft-core/auth-state";

// Isolate the adapter from the real filesystem and network: mock the two
// draft-core primitives it delegates to, plus global fetch for its
// desktop-tolerant whoami hydration.
let writes: AuthState[] = [];
mock.module("draft-core/auth-state", () => ({
  writeAuthState: (state: AuthState) => { writes.push(state); },
}));

let pairDeviceImpl: (deps: any) => Promise<{ access_token: string; refresh_token: string; expires_at: number }> = async () => {
  throw new Error("not configured");
};
class FakeDevicePairingError extends Error {
  constructor(public readonly kind: string) { super(kind); }
}
mock.module("draft-core/device-pairing", () => ({
  pairDevice: (deps: any) => pairDeviceImpl(deps),
  DevicePairingError: FakeDevicePairingError,
}));

const { startBrowserSignIn } = await import("./browser-sign-in");

describe("startBrowserSignIn (desktop adapter)", () => {
  test("opens the URL, emits awaiting_approval, persists auth.json, and completes on success", async () => {
    writes = [];
    const opened: string[] = [];
    const progress: { phase: string; error?: string }[] = [];
    let capturedDeps: any;
    pairDeviceImpl = async (deps) => {
      capturedDeps = deps;
      deps.onUrl("https://app.test/link?code=abc");
      deps.onProgress({ phase: "awaiting_approval" });
      return { access_token: "at", refresh_token: "rt", expires_at: 999 };
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({ organization_id: "org", primary_team_id: "team", workspace_id: "ws", onboarding_completed_at: null })) as unknown as typeof fetch;

    try {
      const controller = new AbortController();
      await startBrowserSignIn(controller.signal, {
        openUrl: (url) => opened.push(url),
        progress: (event) => progress.push(event),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(opened).toEqual(["https://app.test/link?code=abc"]);
    expect(progress).toEqual([{ phase: "awaiting_approval" }, { phase: "complete" }]);
    expect(writes).toHaveLength(2); // pre-whoami persist, then hydrated persist
    expect(writes[0]).toMatchObject({ access_token: "at", identity_resolved: false });
    expect(writes[1]).toMatchObject({ access_token: "at", identity_resolved: true, workspace_id: "ws" });
    expect(capturedDeps.apiUrl).toBeTruthy();
  });

  test("tolerates a failing whoami — sign-in still completes with uncached identity", async () => {
    writes = [];
    const progress: { phase: string; error?: string }[] = [];
    pairDeviceImpl = async (deps) => {
      deps.onUrl("https://app.test/link?code=abc");
      return { access_token: "at", refresh_token: "rt", expires_at: 999 };
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;

    try {
      const controller = new AbortController();
      await startBrowserSignIn(controller.signal, { openUrl: () => {}, progress: (event) => progress.push(event) });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(progress).toEqual([{ phase: "complete" }]);
    expect(writes).toHaveLength(1); // only the pre-whoami persist — hydration failure is non-fatal
    expect(writes[0]).toMatchObject({ identity_resolved: false });
  });

  test("cancellation: aborted pairing emits no error progress event", async () => {
    const progress: { phase: string; error?: string }[] = [];
    const controller = new AbortController();
    pairDeviceImpl = async () => {
      controller.abort();
      throw new FakeDevicePairingError("aborted");
    };
    await startBrowserSignIn(controller.signal, { openUrl: () => {}, progress: (event) => progress.push(event) });
    expect(progress).toEqual([]);
  });

  test("error handling: pairing failure surfaces a single error progress event", async () => {
    const progress: { phase: string; error?: string }[] = [];
    pairDeviceImpl = async () => { throw new FakeDevicePairingError("timed_out"); };
    const controller = new AbortController();
    await startBrowserSignIn(controller.signal, { openUrl: () => {}, progress: (event) => progress.push(event) });
    expect(progress).toEqual([{ phase: "error", error: "timed_out" }]);
  });
});

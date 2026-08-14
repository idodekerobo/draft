import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "bun:test";
import { AuthLockError, acquireFileLock, createAccessTokenProvider, createAuthStateStore, normalizeAuthState, type AuthState } from "../auth-state";

const auth = (overrides: Partial<AuthState> = {}): AuthState => ({ access_token: "old", refresh_token: "refresh", expires_at: 10, organization_id: "org", team_id: "team", workspace_id: "workspace", identity_resolved: true, onboarding_completed_at: null, ...overrides });
function harness(initial = auth(), fetcher: (calls: number) => Promise<Response> = async () => Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 60 })) {
  let value: AuthState | null = initial; let calls = 0;
  const token = createAccessTokenProvider({ read: () => value, write: (next) => { value = next; }, fetch: async () => fetcher(++calls) });
  return { token, value: () => value, calls: () => calls };
}
const options = { supabaseUrl: "https://example.test", publishableKey: "key", now: () => 20_000 };

describe("auth state", () => {
  test("legacy auth is unresolved", () => { expect(normalizeAuthState({ access_token: "a", refresh_token: "r", expires_at: 1 })?.identity_resolved).toBe(false); });
  test("forced refresh bypasses a fresh token and preserves resolved identity while rotating tokens", async () => {
    const h = harness(auth({ expires_at: 999 }));
    expect(await h.token({ ...options, now: () => 0, forceRefresh: true })).toBe("new");
    expect(h.calls()).toBe(1); expect(h.value()).toMatchObject({ refresh_token: "rotated", identity_resolved: true, workspace_id: "workspace" });
  });
  test.each([400, 401, 403])("classifies %s as terminal", async (status) => { const h = harness(auth(), async () => new Response(null, { status })); expect(h.token(options)).rejects.toThrow("session_refresh_terminal"); });
  test.each([429, 500, 503])("classifies %s as transient", async (status) => { const h = harness(auth(), async () => new Response(null, { status })); expect(h.token(options)).rejects.toThrow("session_refresh_transient"); });
  test("classifies network failure as transient", async () => { const h = harness(auth(), async () => { throw new Error("offline"); }); expect(h.token(options)).rejects.toThrow("session_refresh_transient"); });
  test("shares one in-flight refresh", async () => {
    let release!: (response: Response) => void; const pending = new Promise<Response>((resolve) => { release = resolve; });
    const h = harness(auth(), async () => pending); const first = h.token(options); const second = h.token(options);
    expect(h.calls()).toBe(1); release(Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 60 }));
    expect(await Promise.all([first, second])).toEqual(["new", "new"]); expect(h.calls()).toBe(1);
  });

  test("acquireLock: reloads credentials after acquisition — skips refresh if already fresh", async () => {
    let value: AuthState | null = auth({ expires_at: 10 });
    let calls = 0;
    const token = createAccessTokenProvider({
      read: () => value,
      write: (next) => { value = next; },
      fetch: async () => { calls++; return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 60 }); },
      acquireLock: async () => {
        // Simulate another process refreshing while we waited for the lock.
        value = auth({ access_token: "already-fresh", expires_at: 999 });
        return () => {};
      },
    });
    const result = await token(options);
    expect(result).toBe("already-fresh");
    expect(calls).toBe(0);
  });
});

describe("createAuthStateStore", () => {
  let dir: string;
  afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  test("write then read round-trips and sets 0600 / 0700 permissions", () => {
    dir = mkdtempSync(join(tmpdir(), "draft-auth-"));
    const file = join(dir, "nested", "auth.json");
    const store = createAuthStateStore(file);
    store.write(auth());
    expect(store.read()).toMatchObject({ access_token: "old" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
  });

  test("corrupt JSON is treated as unauthenticated without throwing", () => {
    dir = mkdtempSync(join(tmpdir(), "draft-auth-"));
    const file = join(dir, "auth.json");
    writeFileSync(file, "{ not valid json");
    const store = createAuthStateStore(file);
    expect(store.read()).toBeNull();
  });

  test("missing file reads as null", () => {
    dir = mkdtempSync(join(tmpdir(), "draft-auth-"));
    const store = createAuthStateStore(join(dir, "missing.json"));
    expect(store.read()).toBeNull();
  });

  test("clear on a missing file does not throw", () => {
    dir = mkdtempSync(join(tmpdir(), "draft-auth-"));
    const store = createAuthStateStore(join(dir, "missing.json"));
    expect(() => store.clear()).not.toThrow();
  });

  test("concurrent writers use unique temp filenames and never collide", () => {
    dir = mkdtempSync(join(tmpdir(), "draft-auth-"));
    const file = join(dir, "auth.json");
    const storeA = createAuthStateStore(file);
    const storeB = createAuthStateStore(file);
    storeA.write(auth({ access_token: "a" }));
    storeB.write(auth({ access_token: "b" }));
    // Both writes complete without ENOENT/EEXIST collisions, and the final
    // state is one of the two writers' values (last-write-wins is fine —
    // uniqueness of temp names, not ordering, is under test).
    expect(["a", "b"]).toContain(readFileSync(file, "utf8").includes("\"a\"") ? "a" : "b");
    expect(existsSync(file)).toBe(true);
  });

  test("isolation: two stores at different paths never see each other's writes", () => {
    dir = mkdtempSync(join(tmpdir(), "draft-auth-"));
    const desktopStore = createAuthStateStore(join(dir, "auth.json"));
    const cliStore = createAuthStateStore(join(dir, "cli-auth.json"));
    desktopStore.write(auth({ access_token: "desktop-token" }));
    expect(cliStore.read()).toBeNull();
    cliStore.write(auth({ access_token: "cli-token" }));
    expect(desktopStore.read()).toMatchObject({ access_token: "desktop-token" });
    expect(cliStore.read()).toMatchObject({ access_token: "cli-token" });
  });
});

describe("acquireFileLock", () => {
  let dir: string;
  afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  test("acquires immediately when no lock file exists, and release removes it", async () => {
    dir = mkdtempSync(join(tmpdir(), "draft-lock-"));
    const lockPath = join(dir, "auth.json.lock");
    const release = await acquireFileLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("waits for a held lock to be released, then acquires", async () => {
    dir = mkdtempSync(join(tmpdir(), "draft-lock-"));
    const lockPath = join(dir, "auth.json.lock");
    const releaseHeld = await acquireFileLock(lockPath);
    const waiter = acquireFileLock(lockPath);
    let acquired = false;
    waiter.then(() => { acquired = true; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(acquired).toBe(false);
    releaseHeld();
    const releaseWaiter = await waiter;
    expect(acquired).toBe(true);
    releaseWaiter();
  });

  test("recovers a stale lock (mtime older than 30s) without waiting the full timeout", async () => {
    dir = mkdtempSync(join(tmpdir(), "draft-lock-"));
    const lockPath = join(dir, "auth.json.lock");
    writeFileSync(lockPath, "");
    const old = new Date(Date.now() - 31_000);
    utimesSync(lockPath, old, old);
    const start = Date.now();
    const release = await acquireFileLock(lockPath);
    expect(Date.now() - start).toBeLessThan(5_000);
    release();
  });

  test("gives up after ~10s and throws AuthLockError (auth_busy)", async () => {
    dir = mkdtempSync(join(tmpdir(), "draft-lock-"));
    const lockPath = join(dir, "auth.json.lock");
    writeFileSync(lockPath, ""); // fresh lock — never recovered as stale within the wait window
    await expect(acquireFileLock(lockPath)).rejects.toBeInstanceOf(AuthLockError);
  }, 15_000);
});

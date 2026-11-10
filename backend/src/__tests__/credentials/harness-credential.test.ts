import { beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { codexCredentialRules } from "draft-core/harnesses/codex/credential";
import type { CredentialRules } from "draft-core/harnesses/types";
import {
  acquireLease,
  credentialStatus,
  releaseLeaseForRun,
  resolveCredential,
  saveCredential,
  saveRefreshed,
} from "../../credentials/harness-credential";
import { fakeClient, fakeDb } from "../routines/fake-client";

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V2 = randomBytes(32).toString("base64");
});

const WORKSPACE = "ws-1";
const chatgpt = (refresh: string, lastRefresh: string) =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: lastRefresh, tokens: { access_token: "a", refresh_token: refresh } });

// A second harness with no lease and a plain-text login shows that the code works from the rules, not from Codex.
const plainRules: CredentialRules = {
  provider: "plain_harness",
  label: "Plain login",
  validate: (value) => (typeof value === "string" && value.trim() ? value.trim() : null),
  changedDuringRun: (before, after) => before !== after,
  lease: null,
};

describe.each([
  ["Codex", codexCredentialRules, chatgpt("r1", "t1")],
  ["a plain-text harness", plainRules, "secret-token"],
] as const)("a stored login for %s", (_name, rules, secret) => {
  it("is encrypted at rest, read back, and replaced by a second save", async () => {
    const db = fakeDb();
    const client = fakeClient(db);
    expect(await credentialStatus(client, WORKSPACE, rules)).toBeNull();

    const id = await saveCredential(client, WORKSPACE, rules, secret, "user-1");
    expect(JSON.stringify(db.tables.credentials)).not.toContain("secret-token");
    expect(db.tables.credentials![0]!.provider).toBe(rules.provider);
    expect(await resolveCredential(client, WORKSPACE, rules)).toEqual({ credentialId: id, secret });
    expect(await saveCredential(client, WORKSPACE, rules, `${secret}-2`, "user-2")).toBe(id);
    expect(db.tables.credentials).toHaveLength(1);
  });

  it("says why there is no login to use", async () => {
    const db = fakeDb();
    const client = fakeClient(db);
    await expect(resolveCredential(client, WORKSPACE, rules)).rejects.toMatchObject({ reason: "missing" });
    await saveCredential(client, WORKSPACE, rules, secret, "user-1");

    db.tables.credentials![0]!.status = "revoked";
    await expect(resolveCredential(client, WORKSPACE, rules)).rejects.toMatchObject({ reason: "revoked" });
    db.tables.credentials![0]!.status = "pending";
    await expect(resolveCredential(client, WORKSPACE, rules)).rejects.toMatchObject({ reason: "missing" });
    db.tables.credentials![0]!.status = "expired";
    await expect(resolveCredential(client, WORKSPACE, rules)).rejects.toMatchObject({ reason: "expired" });
    db.tables.credentials![0]!.status = "active";
    db.tables.credentials![0]!.expires_at = "2020-01-01T00:00:00Z";
    await expect(resolveCredential(client, WORKSPACE, rules)).rejects.toMatchObject({ reason: "expired" });
  });

  it("keeps only the logins of its own provider apart", async () => {
    const db = fakeDb();
    const client = fakeClient(db);
    await saveCredential(client, WORKSPACE, rules, secret, "user-1");
    const other: CredentialRules = { ...rules, provider: "another_provider" };
    expect(await credentialStatus(client, WORKSPACE, other)).toBeNull();
  });
});

describe("a login the harness refreshed during a run", () => {
  it("is kept when it changed, and ignored when unreadable or unchanged", async () => {
    const db = fakeDb();
    const client = fakeClient(db);
    await saveCredential(client, WORKSPACE, codexCredentialRules, chatgpt("r1", "t1"), "user-1");

    expect(await saveRefreshed(client, WORKSPACE, codexCredentialRules, chatgpt("r1", "t1"))).toBe(false);
    expect(await saveRefreshed(client, WORKSPACE, codexCredentialRules, "not json")).toBe(false);
    expect((await resolveCredential(client, WORKSPACE, codexCredentialRules)).secret).toBe(chatgpt("r1", "t1"));

    expect(await saveRefreshed(client, WORKSPACE, codexCredentialRules, chatgpt("r2", "t2"))).toBe(true);
    expect((await resolveCredential(client, WORKSPACE, codexCredentialRules)).secret).toBe(chatgpt("r2", "t2"));
  });

  it("does not bring back a login that was revoked while the run was going", async () => {
    const db = fakeDb();
    const client = fakeClient(db);
    await saveCredential(client, WORKSPACE, codexCredentialRules, chatgpt("r1", "t1"), "user-1");
    db.tables.credentials![0]!.status = "revoked";
    await expect(saveRefreshed(client, WORKSPACE, codexCredentialRules, chatgpt("r2", "t2"))).rejects.toMatchObject({ reason: "revoked" });
  });
});

describe("the lease", () => {
  it("uses the ttl the rules name", async () => {
    const db = fakeDb({}, { rpcs: { acquire_credential_lease: () => ({ data: true }) } });
    expect(await acquireLease(fakeClient(db), codexCredentialRules, "cred-1", WORKSPACE, "run-1")).toBe(true);
    expect(db.rpcCalls[0]).toEqual({ name: "acquire_credential_lease", args: { p_credential_id: "cred-1", p_workspace_id: WORKSPACE, p_run_id: "run-1", p_ttl: "20 minutes" } });
  });

  it("refuses to lease a login whose rules have no lease", async () => {
    await expect(acquireLease(fakeClient(fakeDb()), plainRules, "cred-1", WORKSPACE, "run-1")).rejects.toThrow("no lease");
  });

  it("releases only for a workspace that has a login", async () => {
    const db = fakeDb({}, { rpcs: { release_credential_lease: () => ({ data: true }) } });
    const client = fakeClient(db);
    await releaseLeaseForRun(client, WORKSPACE, codexCredentialRules, "run-1");
    expect(db.rpcCalls).toEqual([]);
    const id = await saveCredential(client, WORKSPACE, codexCredentialRules, chatgpt("r1", "t1"), "user-1");
    await releaseLeaseForRun(client, WORKSPACE, codexCredentialRules, "run-1");
    expect(db.rpcCalls).toEqual([{ name: "release_credential_lease", args: { p_credential_id: id, p_run_id: "run-1" } }]);
  });
});

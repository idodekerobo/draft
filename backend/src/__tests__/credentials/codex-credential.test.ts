import { beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  acquireCodexLease,
  authJsonChanged,
  codexCredentialStatus,
  parseCodexAuthJson,
  releaseCodexLease,
  resolveCodexCredential,
  saveCodexCredential,
  updateCodexCredential,
} from "../../credentials/codex-credential";
import { CredentialError } from "../../credentials/crypto";
import { fakeClient, fakeDb } from "../routines/fake-client";

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V2 = randomBytes(32).toString("base64");
});

const WORKSPACE = "ws-1";
const chatgpt = (refresh = "r1", lastRefresh = "2026-10-30T00:00:00Z") =>
  JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, last_refresh: lastRefresh, tokens: { access_token: "a", refresh_token: refresh } });

describe("parseCodexAuthJson", () => {
  it("accepts a ChatGPT login with a refresh token and an API key login", () => {
    expect(parseCodexAuthJson(chatgpt())).toBe(chatgpt());
    const apiKey = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test" });
    expect(parseCodexAuthJson(apiKey)).toBe(apiKey);
  });

  it("rejects what cannot run a routine", () => {
    expect(parseCodexAuthJson(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a" } }))).toBeNull();
    expect(parseCodexAuthJson(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: " " }))).toBeNull();
    expect(parseCodexAuthJson(JSON.stringify({ auth_mode: "other" }))).toBeNull();
    expect(parseCodexAuthJson("not json")).toBeNull();
    expect(parseCodexAuthJson("[]")).toBeNull();
    expect(parseCodexAuthJson(42)).toBeNull();
    expect(parseCodexAuthJson(chatgpt("x".repeat(70_000)))).toBeNull();
  });
});

describe("authJsonChanged", () => {
  it("sees a refresh and ignores an untouched file or one it cannot read", () => {
    expect(authJsonChanged(chatgpt("r1", "t1"), chatgpt("r2", "t2"))).toBe(true);
    expect(authJsonChanged(chatgpt("r1", "t1"), chatgpt("r1", "t1"))).toBe(false);
    expect(authJsonChanged(chatgpt(), "not json")).toBe(false);
  });
});

describe("the workspace's Codex login", () => {
  it("is saved encrypted, read back, replaced on a second save, and never stored as plain text", async () => {
    const db = fakeDb();
    const client = fakeClient(db);
    expect(await codexCredentialStatus(client, WORKSPACE)).toBeNull();

    const id = await saveCodexCredential(client, WORKSPACE, chatgpt("r1"), "user-1");
    expect(JSON.stringify(db.tables.credentials)).not.toContain("r1");
    expect(await codexCredentialStatus(client, WORKSPACE)).toBe("active");
    expect(await resolveCodexCredential(client, WORKSPACE)).toEqual({ credentialId: id, authJson: chatgpt("r1") });

    expect(await saveCodexCredential(client, WORKSPACE, chatgpt("r2"), "user-2")).toBe(id);
    expect(db.tables.credentials).toHaveLength(1);
    expect((await resolveCodexCredential(client, WORKSPACE)).authJson).toBe(chatgpt("r2"));
  });

  it("takes back a login that a run refreshed", async () => {
    const client = fakeClient(fakeDb());
    const id = await saveCodexCredential(client, WORKSPACE, chatgpt("r1"), "user-1");
    await updateCodexCredential(client, id, chatgpt("r9", "later"));
    expect((await resolveCodexCredential(client, WORKSPACE)).authJson).toBe(chatgpt("r9", "later"));
  });

  it("says why there is no login to use", async () => {
    const client = fakeClient(fakeDb());
    await expect(resolveCodexCredential(client, WORKSPACE)).rejects.toMatchObject({ reason: "missing" });

    const db = fakeDb();
    const saved = fakeClient(db);
    await saveCodexCredential(saved, WORKSPACE, chatgpt(), "user-1");
    db.tables.credentials![0]!.status = "revoked";
    await expect(resolveCodexCredential(saved, WORKSPACE)).rejects.toBeInstanceOf(CredentialError);
    db.tables.credentials![0]!.status = "active";
    db.tables.credentials![0]!.expires_at = "2020-01-01T00:00:00Z";
    await expect(resolveCodexCredential(saved, WORKSPACE)).rejects.toMatchObject({ reason: "expired" });
  });
});

describe("the login's lease", () => {
  it("passes the ids and a ttl to the lease functions, and reports whether this run got it", async () => {
    const db = fakeDb({}, { rpcs: { acquire_credential_lease: () => ({ data: true }), release_credential_lease: () => ({ data: true }) } });
    const client = fakeClient(db);
    expect(await acquireCodexLease(client, "cred-1", WORKSPACE, "run-1")).toBe(true);
    await releaseCodexLease(client, "cred-1", "run-1");
    expect(db.rpcCalls[0]).toEqual({ name: "acquire_credential_lease", args: { p_credential_id: "cred-1", p_workspace_id: WORKSPACE, p_run_id: "run-1", p_ttl: "20 minutes" } });
    expect(db.rpcCalls[1]).toEqual({ name: "release_credential_lease", args: { p_credential_id: "cred-1", p_run_id: "run-1" } });

    const held = fakeClient(fakeDb({}, { rpcs: { acquire_credential_lease: () => ({ data: false }) } }));
    expect(await acquireCodexLease(held, "cred-1", WORKSPACE, "run-2")).toBe(false);
  });
});

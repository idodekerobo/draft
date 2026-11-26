import { beforeAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { claudeCredentialRules } from "../../cloud-sessions/claude-credential";
import { saveCredential } from "../../credentials/harness-credential";
import { homeModels, workspaceCredentialStore } from "../../home/models";
import { fakeClient, fakeDb } from "../routines/fake-client";

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V2 = randomBytes(32).toString("base64");
});

const WORKSPACE = "ws-1";
const TOKEN = "sk-ant-oat01-home-token";

async function workspaceWithLogin() {
  const db = fakeDb();
  const client = fakeClient(db);
  await saveCredential(client, WORKSPACE, claudeCredentialRules, TOKEN, "user-1");
  return { db, client };
}

describe("the workspace credential store for pi", () => {
  it("hands pi the stored Claude login as an api key, and nothing for other providers", async () => {
    const { client } = await workspaceWithLogin();
    const store = workspaceCredentialStore(client, WORKSPACE);
    expect(await store.read("anthropic")).toEqual({ type: "api_key", key: TOKEN });
    expect(await store.read("openai")).toBeUndefined();
    expect(await store.list()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
  });

  it("reads the login again on every call, so a re-save or a revoke applies at once", async () => {
    const { db, client } = await workspaceWithLogin();
    const store = workspaceCredentialStore(client, WORKSPACE);
    await saveCredential(client, WORKSPACE, claudeCredentialRules, "sk-ant-oat01-second", "user-2");
    expect(await store.read("anthropic")).toMatchObject({ key: "sk-ant-oat01-second" });
    db.tables.credentials![0]!.status = "revoked";
    await expect(store.read("anthropic")).rejects.toMatchObject({ reason: "revoked" });
  });

  it("reads as not configured when the workspace has no login", async () => {
    const store = workspaceCredentialStore(fakeClient(fakeDb()), WORKSPACE);
    expect(await store.read("anthropic")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("never writes back: pi's write path leaves the stored login as it was", async () => {
    const { db, client } = await workspaceWithLogin();
    const before = JSON.stringify(db.tables.credentials);
    const store = workspaceCredentialStore(client, WORKSPACE);
    await store.modify("anthropic", async () => ({ type: "api_key", key: "something-else" }));
    await store.delete("anthropic");
    expect(JSON.stringify(db.tables.credentials)).toBe(before);
  });

  it("resolves request auth through pi's own models, with the workspace token", async () => {
    const { client } = await workspaceWithLogin();
    const models = homeModels(client, WORKSPACE);
    const model = models.getModels("anthropic")[0]!;
    const result = await models.getAuth(model);
    expect(result?.auth.apiKey).toBe(TOKEN);
  });
});

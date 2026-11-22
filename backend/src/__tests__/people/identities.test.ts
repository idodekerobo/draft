import { describe, expect, it } from "bun:test";
import { removePersonIdentity, replacePersonIdentity } from "../../people/identities";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "99999999-9999-4999-8999-999999999999";
const CORY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DANA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ELSEWHERE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const identity = (id: string, personId: string, provider: string, externalId: string, status: string, handle: string | null = null) =>
  ({ id, workspace_id: WS, person_id: personId, provider, external_id: externalId, status, handle, evidence: {} });

function setup(identities: Array<ReturnType<typeof identity>>) {
  const db = fakeDb(
    {
      people: [
        { id: CORY, workspace_id: WS, display_name: "Cory Banks" },
        { id: DANA, workspace_id: WS, display_name: "Dana Lee" },
        { id: ELSEWHERE, workspace_id: OTHER_WS, display_name: "Elsewhere" },
      ],
      person_identities: identities,
    },
    { unique: { person_identities: [["workspace_id", "provider", "external_id"]] } },
  );
  return { db, client: fakeClient(db), rows: () => db.tables.person_identities!.map(({ id, person_id, external_id, status, handle }) => ({ id, person_id, external_id, status, handle })) };
}

describe("removePersonIdentity", () => {
  it("removes an identity that is only a guess, and leaves the person's others alone", async () => {
    const { client, rows } = setup([identity("g1", CORY, "slack", "U1", "inferred"), identity("t1", CORY, "email", "cory@x.com", "confirmed")]);
    expect(await removePersonIdentity(client, WS, { personId: CORY, provider: "slack", externalId: "U1" })).toEqual({ ok: true, outcome: "removed" });
    expect(rows().map((row) => row.id)).toEqual(["t1"]);
  });

  it("matches an email whatever its case or spacing", async () => {
    const { client, rows } = setup([identity("g1", CORY, "email", "cory@x.com", "inferred")]);
    expect(await removePersonIdentity(client, WS, { personId: CORY, provider: "email", externalId: " CORY@X.com " })).toEqual({ ok: true, outcome: "removed" });
    expect(rows()).toEqual([]);
  });

  it.each(["confirmed", "from_connection"])("refuses a %s identity and keeps it, because its source keeps it in step", async (status) => {
    const { client, rows } = setup([identity("t1", CORY, "slack", "U1", status)]);
    expect(await removePersonIdentity(client, WS, { personId: CORY, provider: "slack", externalId: "U1" })).toEqual({ ok: false, code: "identity_trusted" });
    expect(rows().map((row) => row.id)).toEqual(["t1"]);
  });

  it("reads another person's identity as not found, and keeps it", async () => {
    const { client, rows } = setup([identity("g1", DANA, "slack", "U1", "inferred")]);
    expect(await removePersonIdentity(client, WS, { personId: CORY, provider: "slack", externalId: "U1" })).toEqual({ ok: false, code: "identity_not_found" });
    expect(rows().map((row) => row.id)).toEqual(["g1"]);
  });

  it("says when the person has no such identity, and when the person is not in this workspace", async () => {
    const { client } = setup([]);
    expect(await removePersonIdentity(client, WS, { personId: CORY, provider: "slack", externalId: "U1" })).toEqual({ ok: false, code: "identity_not_found" });
    expect(await removePersonIdentity(client, WS, { personId: ELSEWHERE, provider: "slack", externalId: "U1" })).toEqual({ ok: false, code: "person_not_found" });
  });
});

describe("replacePersonIdentity", () => {
  const evidence = { quote: "Cory corrected the address in standup." };

  it("swaps a guessed identity for the corrected one, which is a guess too", async () => {
    const { client, rows } = setup([identity("g1", CORY, "email", "cory@old.com", "inferred")]);
    const result = await replacePersonIdentity(client, WS, { personId: CORY, provider: "email", replaces: "cory@old.com", externalId: "Cory@New.com", handle: "cory", evidence });
    expect(result).toEqual({ ok: true, outcome: "replaced" });
    expect(rows()).toEqual([expect.objectContaining({ person_id: CORY, external_id: "cory@new.com", status: "inferred", handle: "cory" })]);
  });

  it("leaves the old identity when the new one belongs to someone else", async () => {
    const { client, rows } = setup([identity("g1", CORY, "email", "cory@old.com", "inferred"), identity("t1", DANA, "email", "dana@x.com", "confirmed")]);
    const result = await replacePersonIdentity(client, WS, { personId: CORY, provider: "email", replaces: "cory@old.com", externalId: "dana@x.com", evidence });
    expect(result).toEqual({ ok: false, code: "identity_taken" });
    expect(rows().map((row) => row.id)).toEqual(["g1", "t1"]);
  });

  it("refuses to replace a trusted identity, and adds nothing", async () => {
    const { client, rows } = setup([identity("t1", CORY, "email", "cory@old.com", "confirmed")]);
    const result = await replacePersonIdentity(client, WS, { personId: CORY, provider: "email", replaces: "cory@old.com", externalId: "cory@new.com", evidence });
    expect(result).toEqual({ ok: false, code: "identity_trusted" });
    expect(rows().map((row) => row.external_id)).toEqual(["cory@old.com"]);
  });

  it("says when the identity to replace is not the person's", async () => {
    const { client, rows } = setup([identity("g1", DANA, "email", "cory@old.com", "inferred")]);
    const result = await replacePersonIdentity(client, WS, { personId: CORY, provider: "email", replaces: "cory@old.com", externalId: "cory@new.com", evidence });
    expect(result).toEqual({ ok: false, code: "identity_not_found" });
    expect(rows().map((row) => row.external_id)).toEqual(["cory@old.com"]);
  });

  it("changes nothing but the display name when the id is the same", async () => {
    const { client, rows } = setup([identity("g1", CORY, "slack", "U1", "inferred", "old")]);
    const result = await replacePersonIdentity(client, WS, { personId: CORY, provider: "slack", replaces: "U1", externalId: "U1", handle: "new", evidence });
    expect(result).toEqual({ ok: true, outcome: "unchanged" });
    expect(rows()).toEqual([expect.objectContaining({ id: "g1", external_id: "U1", handle: "new" })]);
  });

  it("keeps a trusted identity the person already has as the new one, and drops the guess", async () => {
    const { client, rows } = setup([identity("g1", CORY, "email", "cory@typo.com", "inferred"), identity("t1", CORY, "email", "cory@real.com", "confirmed")]);
    const result = await replacePersonIdentity(client, WS, { personId: CORY, provider: "email", replaces: "cory@typo.com", externalId: "cory@real.com", evidence });
    expect(result).toEqual({ ok: true, outcome: "replaced" });
    expect(rows()).toEqual([expect.objectContaining({ id: "t1", external_id: "cory@real.com", status: "confirmed" })]);
  });

  it("says when the person is not in this workspace", async () => {
    const { client } = setup([]);
    expect(await replacePersonIdentity(client, WS, { personId: ELSEWHERE, provider: "slack", replaces: "U1", externalId: "U2", evidence })).toEqual({ ok: false, code: "person_not_found" });
  });
});

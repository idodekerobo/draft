import { describe, expect, it } from "bun:test";
import { parseCloudStart } from "../../cloud-sessions/parse-start";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "66666666-6666-4666-8666-666666666666";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const owner = { workspaceId: WS, ownerUserId: OWNER };
const repoSeed = (overrides: Record<string, unknown> = {}) => ({ kind: "repo", gitRemote: "https://github.com/acme/app", branch: "main", ...overrides });
const body = (overrides: Record<string, unknown> = {}) => ({ runtime: "cloud", harness: "claude", model: "haiku", seed: repoSeed(), ...overrides });

function errorOf(result: ReturnType<typeof parseCloudStart>): string | null {
  return result.ok ? null : result.error;
}

describe("parseCloudStart", () => {
  it("accepts a repo seed and keeps the owner, network and repository scope", () => {
    const result = parseCloudStart(body({ seed: repoSeed({ gitRemote: "https://github.com/acme/app.git" }) }), owner);
    expect(result).toEqual({
      ok: true,
      input: {
        workspaceId: WS,
        ownerUserId: OWNER,
        harness: "claude",
        model: "haiku",
        reasoningEffort: null,
        network: "restricted",
        seed: { kind: "repo", gitRemote: "https://github.com/acme/app.git", repo: "acme/app", branch: "main" },
      },
    });
  });

  it("takes an open network and a reasoning effort the model lists", () => {
    const result = parseCloudStart(body({ network: "open", reasoningEffort: "high" }), owner);
    expect(result.ok && result.input.network).toBe("open");
    expect(result.ok && result.input.reasoningEffort).toBe("high");
  });

  it("refuses a harness other than claude, and a model or effort the harness does not list", () => {
    expect(errorOf(parseCloudStart(body({ harness: "codex" }), owner))).toBe("harness_not_supported");
    expect(errorOf(parseCloudStart(body({ model: "gpt-5" }), owner))).toBe("unknown_model");
    expect(errorOf(parseCloudStart(body({ model: 12 }), owner))).toBe("unknown_model");
    expect(errorOf(parseCloudStart(body({ reasoningEffort: "ultra" }), owner))).toBe("unknown_reasoning_effort");
  });

  it("refuses a network other than restricted or open", () => {
    expect(errorOf(parseCloudStart(body({ network: "public" }), owner))).toBe("invalid_network");
  });

  it("refuses a missing seed, and a remote that is not an https GitHub repository", () => {
    expect(errorOf(parseCloudStart({ model: "haiku" }, owner))).toBe("invalid_seed");
    const remotes = [
      "http://github.com/acme/app",
      "https://gitlab.com/acme/app",
      "https://user@github.com/acme/app",
      "https://github.com/acme/app/tree/main",
      "https://github.com/acme/app?x=1",
      "https://github.com/-acme/app",
      "https://github.com/acme/..",
      "https://github.com/acme/.git",
      "git@github.com:acme/app.git",
      "https://github.com/acme/app ",
    ];
    for (const gitRemote of remotes) {
      expect(errorOf(parseCloudStart(body({ seed: repoSeed({ gitRemote }) }), owner))).toBe("invalid_seed");
    }
  });

  it("refuses a branch that git would not accept or that could read as an option", () => {
    for (const branch of ["-main", "a..b", "feature/", "main.lock", "", "x//y", "main."]) {
      expect(errorOf(parseCloudStart(body({ seed: repoSeed({ branch }) }), owner))).toBe("invalid_seed");
    }
  });

  it("accepts a snapshot whose key is this workspace's session seed, and takes the session id from the key", () => {
    const result = parseCloudStart(body({ seed: { kind: "snapshot", storageKey: `${WS}/${SESSION}/seed.tar.gz`, folderName: "marigold" } }), owner);
    expect(result).toEqual({
      ok: true,
      input: {
        workspaceId: WS,
        ownerUserId: OWNER,
        harness: "claude",
        model: "haiku",
        reasoningEffort: null,
        network: "restricted",
        seed: { kind: "snapshot", sessionId: SESSION, storageKey: `${WS}/${SESSION}/seed.tar.gz`, folderName: "marigold" },
      },
    });
  });

  it("accepts a body sessionId only when it is the key's session", () => {
    const key = `${WS}/${SESSION}/seed.tar.gz`;
    expect(parseCloudStart(body({ sessionId: SESSION, seed: { kind: "snapshot", storageKey: key } }), owner).ok).toBe(true);
    expect(errorOf(parseCloudStart(body({ sessionId: OTHER_SESSION, seed: { kind: "snapshot", storageKey: key } }), owner))).toBe("invalid_seed");
    expect(errorOf(parseCloudStart(body({ sessionId: "not-a-uuid", seed: { kind: "snapshot", storageKey: key } }), owner))).toBe("invalid_seed");
  });

  it("refuses a snapshot key outside this workspace, outside the seed file, or with a session id that is not a UUID", () => {
    const refused = [
      `other-ws/${SESSION}/seed.tar.gz`,
      `${WS}/../seed.tar.gz`,
      `${WS}/${SESSION}/other.tar.gz`,
      `${WS}/${SESSION}/nested/seed.tar.gz`,
      `${WS}/not-a-uuid/seed.tar.gz`,
      `${WS}/${SESSION.toUpperCase()}/seed.tar.gz`,
      `${WS}/${SESSION}/seed.tar.gz/../../other`,
    ];
    for (const storageKey of refused) {
      expect(errorOf(parseCloudStart(body({ seed: { kind: "snapshot", storageKey } }), owner))).toBe("invalid_seed");
    }
    expect(errorOf(parseCloudStart(body({ seed: { kind: "snapshot" } }), owner))).toBe("invalid_seed");
  });

  it("gives a snapshot the folder name it was sent with, and 'snapshot' when the name is missing or unusable", () => {
    const seedWith = (folderName: unknown) => ({ kind: "snapshot", storageKey: `${WS}/${SESSION}/seed.tar.gz`, folderName });
    const nameOf = (folderName: unknown) => {
      const result = parseCloudStart(body({ seed: seedWith(folderName) }), owner);
      return result.ok && result.input.seed.kind === "snapshot" ? result.input.seed.folderName : null;
    };
    expect(nameOf("  marigold  ")).toBe("marigold");
    expect(nameOf(undefined)).toBe("snapshot");
    expect(nameOf(42)).toBe("snapshot");
    expect(nameOf("")).toBe("snapshot");
    expect(nameOf("x".repeat(201))).toBe("snapshot");
    expect(nameOf("bad\nname")).toBe("snapshot");
  });

  it("refuses a session id on a repository seed", () => {
    expect(errorOf(parseCloudStart(body({ sessionId: SESSION }), owner))).toBe("invalid_seed");
  });

  it("accepts a routine_run seed that names a routine run by its session id", () => {
    const result = parseCloudStart(body({ seed: { kind: "routine_run", sessionId: OTHER_SESSION } }), owner);
    expect(result).toMatchObject({ ok: true, input: { seed: { kind: "routine_run", routineSessionId: OTHER_SESSION }, network: "restricted" } });
  });

  it("refuses a routine_run seed whose session id is missing, not a UUID, or sent beside a body sessionId", () => {
    expect(errorOf(parseCloudStart(body({ seed: { kind: "routine_run" } }), owner))).toBe("invalid_seed");
    expect(errorOf(parseCloudStart(body({ seed: { kind: "routine_run", sessionId: "not-a-uuid" } }), owner))).toBe("invalid_seed");
    expect(errorOf(parseCloudStart(body({ seed: { kind: "routine_run", sessionId: OTHER_SESSION }, sessionId: SESSION }), owner))).toBe("invalid_seed");
  });
});

import { describe, expect, it } from "bun:test";
import { parseCloudStart } from "../../cloud-sessions/parse-start";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "66666666-6666-4666-8666-666666666666";
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

  it("checks a snapshot's key against the workspace, then refuses it as not yet supported", () => {
    expect(errorOf(parseCloudStart(body({ seed: { kind: "snapshot", storageKey: "other-ws/snap.tar.gz" } }), owner))).toBe("invalid_seed");
    expect(errorOf(parseCloudStart(body({ seed: { kind: "snapshot", storageKey: `${WS}/../snap.tar.gz` } }), owner))).toBe("invalid_seed");
    expect(errorOf(parseCloudStart(body({ seed: { kind: "snapshot", storageKey: `${WS}/snap.tar.gz` } }), owner))).toBe("snapshot_not_supported");
  });
});

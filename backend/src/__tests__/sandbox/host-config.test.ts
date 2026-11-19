import { describe, expect, it } from "bun:test";
import { HostConfigError, isVolumeHome, parseHostConfig, parseSeed } from "../../sandbox/host/config";

const env = {
  DRAFT_API_BASE_URL: "https://api.example.test/",
  DRAFT_RUN_TOKEN: "run-token-value",
  DRAFT_SESSION_ID: "sess_1",
  DRAFT_WORKSPACE_ID: "ws-1",
  DRAFT_SEED: JSON.stringify({ kind: "repo", gitRemote: "https://github.com/acme/app.git", branch: "main" }),
  HOME: "/data",
};

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a throw");
}

describe("parseHostConfig", () => {
  it("reads the environment and drops a trailing slash from the API base", () => {
    expect(parseHostConfig(env)).toEqual({
      apiBase: "https://api.example.test",
      runToken: "run-token-value",
      sessionId: "sess_1",
      workspaceId: "ws-1",
      home: "/data",
      seed: { kind: "repo", gitRemote: "https://github.com/acme/app.git", branch: "main" },
    });
  });

  it("names every missing variable in one message", () => {
    expect(messageOf(() => parseHostConfig({ ...env, DRAFT_RUN_TOKEN: undefined, DRAFT_SEED: "" }))).toBe(
      "missing required environment variables: DRAFT_RUN_TOKEN, DRAFT_SEED",
    );
  });

  it("refuses an id that could change the URL path", () => {
    expect(() => parseHostConfig({ ...env, DRAFT_SESSION_ID: "../other" })).toThrow(HostConfigError);
  });

  it("refuses an API base that is not an http or https URL", () => {
    expect(messageOf(() => parseHostConfig({ ...env, DRAFT_API_BASE_URL: "file:///etc" }))).toBe("DRAFT_API_BASE_URL must be an http or https URL");
    expect(messageOf(() => parseHostConfig({ ...env, DRAFT_API_BASE_URL: "not a url" }))).toBe("DRAFT_API_BASE_URL is not a URL");
  });
});

describe("parseSeed", () => {
  it("accepts a repo with an https, ssh or scp-style remote", () => {
    for (const gitRemote of ["https://github.com/acme/app.git", "ssh://git@github.com/acme/app.git", "git@github.com:acme/app.git"]) {
      expect(parseSeed(JSON.stringify({ kind: "repo", gitRemote, branch: "feature/x" }))).toEqual({ kind: "repo", gitRemote, branch: "feature/x" });
    }
  });

  it("accepts a snapshot with an https URL", () => {
    expect(parseSeed(JSON.stringify({ kind: "snapshot", url: "https://files.example.test/snap.tar.gz?sig=abc" }))).toEqual({
      kind: "snapshot",
      url: "https://files.example.test/snap.tar.gz?sig=abc",
    });
  });

  it("refuses a remote or branch that git could read as an option", () => {
    expect(() => parseSeed(JSON.stringify({ kind: "repo", gitRemote: "--upload-pack=touch /x", branch: "main" }))).toThrow(HostConfigError);
    expect(() => parseSeed(JSON.stringify({ kind: "repo", gitRemote: "git@-oProxyCommand:x", branch: "main" }))).toThrow(HostConfigError);
    expect(() => parseSeed(JSON.stringify({ kind: "repo", gitRemote: "https://github.com/a/b.git", branch: "--orphan" }))).toThrow(HostConfigError);
    expect(() => parseSeed(JSON.stringify({ kind: "repo", gitRemote: "https://github.com/a/b.git", branch: "a..b" }))).toThrow(HostConfigError);
  });

  it("refuses a file remote, an unknown kind, a non-object and invalid JSON", () => {
    expect(() => parseSeed(JSON.stringify({ kind: "repo", gitRemote: "file:///etc", branch: "main" }))).toThrow(HostConfigError);
    expect(() => parseSeed(JSON.stringify({ kind: "zip" }))).toThrow('DRAFT_SEED kind must be "repo" or "snapshot"');
    expect(() => parseSeed("[]")).toThrow("DRAFT_SEED must be a JSON object");
    expect(() => parseSeed("{not json")).toThrow("DRAFT_SEED is not valid JSON");
  });

  it("refuses a snapshot URL that is not https", () => {
    expect(() => parseSeed(JSON.stringify({ kind: "snapshot", url: "http://files.example.test/a.tgz" }))).toThrow("DRAFT_SEED snapshot.url must be https");
  });

  it("never echoes a seed value in its error", () => {
    const secret = "ghp_SECRET_VALUE_123";
    const raw = JSON.stringify({ kind: "repo", gitRemote: `https://x-access-token:${secret}@github.com/acme/app.git with spaces`, branch: "main" });
    expect(messageOf(() => parseSeed(raw))).not.toContain(secret);
    expect(messageOf(() => parseSeed(`{"kind":"repo","gitRemote":"${secret}`))).not.toContain(secret);
  });
});

describe("isVolumeHome", () => {
  it("accepts /data and paths under it", () => {
    expect(isVolumeHome("/data")).toBe(true);
    expect(isVolumeHome("/data/")).toBe(true);
    expect(isVolumeHome("/data/home/agent")).toBe(true);
  });

  it("refuses any other HOME, including a sibling that starts with the same letters", () => {
    expect(isVolumeHome("/root")).toBe(false);
    expect(isVolumeHome("/home/agent")).toBe(false);
    expect(isVolumeHome("/database")).toBe(false);
    expect(isVolumeHome("data")).toBe(false);
    expect(isVolumeHome("")).toBe(false);
  });

  it("refuses a path that only reaches /data through dot segments", () => {
    expect(isVolumeHome("/data/../etc")).toBe(false);
    expect(isVolumeHome("/data/..")).toBe(false);
  });
});

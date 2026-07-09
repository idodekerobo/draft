import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  publishTeamContext,
  listUnpublishedContextPaths,
  PublishError,
} from "../sync/publish";
import { capture as realCapture } from "../exec";
import { openHistoryDb, insertFileVersion, getLatestUnpublishedVersion } from "../db/history";

const TMP = `/tmp/draft-core-publish-test-${Date.now()}`;
let counter = 0;
function tmpDir(name: string): string {
  return join(TMP, `${name}-${counter++}`);
}

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

async function makeBareTeamRepo(): Promise<string> {
  const bareRepo = tmpDir("team-repo.git");
  mkdirSync(bareRepo, { recursive: true });
  const init = await realCapture(["git", "init", "--bare", "-b", "main", bareRepo]);
  expect(init.exitCode).toBe(0);

  // Seed with an initial commit so subsequent clones have a branch to push to.
  const seed = tmpDir("seed");
  mkdirSync(seed, { recursive: true });
  await realCapture(["git", "clone", bareRepo, seed]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  await realCapture(["git", "-C", seed, "add", "-A"]);
  await realCapture(["git", "-C", seed, "commit", "-m", "seed"]);
  const push = await realCapture(["git", "-C", seed, "push", "origin", "main"]);
  expect(push.exitCode).toBe(0);

  return bareRepo;
}

function setupWorkspace(teamRepoUrl: string): string {
  const workspace = tmpDir("workspace");
  mkdirSync(join(workspace, "context", "product"), { recursive: true });
  mkdirSync(join(workspace, "context", "team"), { recursive: true });
  mkdirSync(join(workspace, "config"), { recursive: true });
  writeFileSync(join(workspace, "context", "product", "index.md"), "# Product\n\ncontent A\n");
  writeFileSync(join(workspace, "context", "team", "index.md"), "# Team\n\ncontent B\n");
  writeFileSync(
    join(workspace, "config", "collaboration.json"),
    JSON.stringify({ mode: "github", team_repo_url: teamRepoUrl, team_repo_subdir: "root" }, null, 2)
  );
  return workspace;
}

function insertVersion(workspace: string, filePath: string, content: string, publishedAt: string | null = null) {
  const db = openHistoryDb(workspace);
  try {
    return insertFileVersion(db, {
      filePath,
      content,
      createdAt: new Date().toISOString(),
      source: "human-edit",
      author: "tester",
      sessionId: null,
      publishedAt,
      changesEntryId: null,
    });
  } finally {
    db.close();
  }
}

describe("publishTeamContext — scoped publish", () => {
  it("publishes only the named file(s), leaves skills/mcp/accepted untouched", async () => {
    const bareRepo = await makeBareTeamRepo();
    const workspace = setupWorkspace(bareRepo);

    mkdirSync(join(workspace, "skills", "somepack"), { recursive: true });
    writeFileSync(join(workspace, "skills", "somepack", "SKILL.md"), "skill\n");
    writeFileSync(join(workspace, "config", "mcp.json"), JSON.stringify({ version: 1, servers: [] }));
    mkdirSync(join(workspace, "accepted"), { recursive: true });
    writeFileSync(join(workspace, "accepted", "proposal1.md"), "a proposal\n");

    insertVersion(workspace, "product/index.md", "content A");
    insertVersion(workspace, "team/index.md", "content B");

    const result = await publishTeamContext(workspace, "test-profile", { paths: ["product/index.md"] });
    expect(result.ok).toBe(true);
    expect(result.published).toBe(true);
    expect(result.scoped).toBe(true);
    expect(result.files).toEqual(["product/index.md"]);
    expect(result.proposalsCleared).toBe(0);

    const checkout = tmpDir("checkout");
    await realCapture(["git", "clone", bareRepo, checkout]);
    expect(existsSync(join(checkout, "context", "product", "index.md"))).toBe(true);
    expect(existsSync(join(checkout, "context", "team", "index.md"))).toBe(false);
    expect(existsSync(join(checkout, "skills"))).toBe(false);
    expect(existsSync(join(checkout, "config", "mcp.json"))).toBe(false);

    const changes = readFileSync(join(checkout, "CHANGES.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const lastChange = changes[changes.length - 1];
    expect(lastChange.files).toEqual(["context/product/index.md"]);

    // accepted/ untouched
    expect(existsSync(join(workspace, "accepted", "proposal1.md"))).toBe(true);

    // history.db: only product/index.md marked published
    const db = openHistoryDb(workspace);
    const productVersion = getLatestUnpublishedVersion(db, "product/index.md");
    const teamVersion = getLatestUnpublishedVersion(db, "team/index.md");
    db.close();
    expect(productVersion?.publishedAt).not.toBeNull();
    expect(teamVersion?.publishedAt).toBeNull();
  });
});

describe("publishTeamContext — full publish", () => {
  it("publishes context, skills, mcp.json and clears accepted proposals (regression)", async () => {
    const bareRepo = await makeBareTeamRepo();
    const workspace = setupWorkspace(bareRepo);

    mkdirSync(join(workspace, "skills", "somepack"), { recursive: true });
    writeFileSync(join(workspace, "skills", "somepack", "SKILL.md"), "skill\n");
    writeFileSync(join(workspace, "config", "mcp.json"), JSON.stringify({ version: 1, servers: [] }));
    mkdirSync(join(workspace, "accepted"), { recursive: true });
    writeFileSync(join(workspace, "accepted", "proposal1.md"), "a proposal\n");

    insertVersion(workspace, "product/index.md", "content A");
    insertVersion(workspace, "team/index.md", "content B");

    const result = await publishTeamContext(workspace, "test-profile");
    expect(result.ok).toBe(true);
    expect(result.published).toBe(true);
    expect(result.scoped).toBe(false);
    expect(result.proposalsCleared).toBe(1);

    const checkout = tmpDir("checkout");
    await realCapture(["git", "clone", bareRepo, checkout]);
    expect(existsSync(join(checkout, "context", "product", "index.md"))).toBe(true);
    expect(existsSync(join(checkout, "context", "team", "index.md"))).toBe(true);
    expect(existsSync(join(checkout, "skills", "somepack", "SKILL.md"))).toBe(true);
    expect(existsSync(join(checkout, "config", "mcp.json"))).toBe(true);

    expect(existsSync(join(workspace, "accepted", "proposal1.md"))).toBe(false);

    const db = openHistoryDb(workspace);
    const productVersion = getLatestUnpublishedVersion(db, "product/index.md");
    const teamVersion = getLatestUnpublishedVersion(db, "team/index.md");
    db.close();
    expect(productVersion?.publishedAt).not.toBeNull();
    expect(teamVersion?.publishedAt).not.toBeNull();
  });
});

describe("listUnpublishedContextPaths", () => {
  it("returns only files whose latest version is unpublished", async () => {
    const bareRepo = await makeBareTeamRepo();
    const workspace = setupWorkspace(bareRepo);

    insertVersion(workspace, "product/index.md", "content A", null);
    insertVersion(workspace, "team/index.md", "content B", new Date().toISOString());

    const paths = listUnpublishedContextPaths(workspace);
    expect(paths).toEqual(["product/index.md"]);
  });
});

describe("publishTeamContext — path-escape guard", () => {
  it("throws PublishError and writes nothing when a path escapes context/", async () => {
    const bareRepo = await makeBareTeamRepo();
    const workspace = setupWorkspace(bareRepo);

    await expect(
      publishTeamContext(workspace, "test-profile", { paths: ["../../etc/passwd"] })
    ).rejects.toBeInstanceOf(PublishError);

    // No commit should have landed in the team repo.
    const checkout = tmpDir("checkout");
    await realCapture(["git", "clone", bareRepo, checkout]);
    expect(existsSync(join(checkout, "context"))).toBe(false);
  });
});

describe("publishTeamContext — capture DI", () => {
  it("uses the injected capture function, not the default", async () => {
    const bareRepo = await makeBareTeamRepo();
    const workspace = setupWorkspace(bareRepo);
    insertVersion(workspace, "product/index.md", "content A");

    let calls = 0;
    const stubCapture: typeof realCapture = (cmd, opts) => {
      calls++;
      return realCapture(cmd, opts);
    };

    const result = await publishTeamContext(workspace, "test-profile", {
      paths: ["product/index.md"],
      capture: stubCapture,
    });

    expect(result.ok).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptureResult } from "draft-core/exec";
import { prepareWorkspace, SeedError, type SeedDeps } from "../../sandbox/host/seed";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "draft-host-seed-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ok = (): CaptureResult => ({ exitCode: 0, stdout: "", stderr: "" });
const noFetch = async (): Promise<Response> => {
  throw new Error("fetch should not be called");
};

/** Records each command. `respond` decides the result and may write files, as git or tar would. */
function recorder(respond: (argv: string[], cwd?: string) => CaptureResult | Promise<CaptureResult> = ok) {
  const calls: Array<{ argv: string[]; cwd?: string }> = [];
  const exec: SeedDeps["exec"] = async (argv, options) => {
    calls.push({ argv, cwd: options?.cwd });
    return respond(argv, options?.cwd);
  };
  return { calls, exec };
}

describe("prepareWorkspace", () => {
  it("keeps a workspace that already exists and runs nothing", async () => {
    const root = join(dir, "workspace");
    mkdirSync(root);
    writeFileSync(join(root, "keep.txt"), "mine");
    const { calls, exec } = recorder();

    const result = await prepareWorkspace({ kind: "snapshot", url: "https://files.example.test/a.tgz" }, root, { exec, fetch: noFetch });

    expect(result).toBe("existing");
    expect(calls).toEqual([]);
    expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("mine");
  });

  it("clones the branch into a partial folder, then moves it into place", async () => {
    const root = join(dir, "workspace");
    const { calls, exec } = recorder((argv) => {
      const target = argv[argv.length - 1]!;
      mkdirSync(target);
      writeFileSync(join(target, "README.md"), "hello");
      return ok();
    });

    const result = await prepareWorkspace({ kind: "repo", gitRemote: "https://github.com/acme/app.git", branch: "main" }, root, { exec, fetch: noFetch });

    expect(result).toBe("prepared");
    expect(calls).toEqual([{ argv: ["git", "clone", "--branch", "main", "--", "https://github.com/acme/app.git", `${root}.partial`] }]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("hello");
    expect(existsSync(`${root}.partial`)).toBe(false);
  });

  it("starts a routine run's chat in an empty git repository, with no download and no clone", async () => {
    const root = join(dir, "workspace");
    const { calls, exec } = recorder();

    const result = await prepareWorkspace({ kind: "routine_run" }, root, { exec, fetch: noFetch });

    expect(result).toBe("prepared");
    expect(calls).toEqual([{ argv: ["git", "init"], cwd: `${root}.partial` }]);
    expect(existsSync(root)).toBe(true);
    expect(existsSync(`${root}.partial`)).toBe(false);
  });

  it("cleans up and hides the remote's token when git fails", async () => {
    const root = join(dir, "workspace");
    const remote = "https://x-access-token:ghp_SECRET123@github.com/acme/app.git";
    const { exec } = recorder(() => ({ exitCode: 128, stdout: "", stderr: `fatal: unable to access '${remote}': 403` }));

    let caught: unknown;
    try {
      await prepareWorkspace({ kind: "repo", gitRemote: remote, branch: "main" }, root, { exec, fetch: noFetch });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SeedError);
    const message = (caught as Error).message;
    expect(message).toContain("git clone failed with exit 128");
    expect(message).not.toContain("ghp_SECRET123");
    expect(existsSync(root)).toBe(false);
    expect(existsSync(`${root}.partial`)).toBe(false);
  });

  it("extracts a snapshot, then makes it a git repository with one commit", async () => {
    const root = join(dir, "workspace");
    const archiveBytes = new Uint8Array([1, 2, 3]);
    const fetched: string[] = [];
    const archivedBytes: number[][] = [];
    const { calls, exec } = recorder((argv) => {
      if (argv[0] === "tar") {
        archivedBytes.push(Array.from(readFileSync(argv[2]!)));
        writeFileSync(join(argv[argv.indexOf("-C") + 1]!, "notes.md"), "snapshot");
      }
      return ok();
    });

    const result = await prepareWorkspace({ kind: "snapshot", url: "https://files.example.test/a.tgz" }, root, {
      exec,
      fetch: async (url) => {
        fetched.push(url);
        return new Response(archiveBytes);
      },
    });

    const partial = `${root}.partial`;
    expect(result).toBe("prepared");
    expect(fetched).toEqual(["https://files.example.test/a.tgz"]);
    expect(archivedBytes).toEqual([[1, 2, 3]]);
    expect(calls.map((call) => call.argv)).toEqual([
      ["tar", "-xzf", `${partial}.tar.gz`, "-C", partial, "--no-same-owner"],
      ["git", "init"],
      ["git", "add", "-A"],
      ["git", "-c", "user.name=Draft", "-c", "user.email=draft-sandbox@localhost", "commit", "--allow-empty", "-m", "Snapshot"],
    ]);
    expect(calls.slice(1).every((call) => call.cwd === partial)).toBe(true);
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("snapshot");
    expect(existsSync(`${partial}.tar.gz`)).toBe(false);
  });

  it("refuses a snapshot the download rejects, and leaves nothing behind", async () => {
    const root = join(dir, "workspace");
    const { calls, exec } = recorder();

    await expect(
      prepareWorkspace({ kind: "snapshot", url: "https://files.example.test/a.tgz" }, root, {
        exec,
        fetch: async () => new Response("denied", { status: 403 }),
      }),
    ).rejects.toThrow("snapshot download failed with status 403");

    expect(calls).toEqual([]);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(`${root}.partial`)).toBe(false);
  });

  it("removes the archive and the partial folder when extraction fails", async () => {
    const root = join(dir, "workspace");
    const { exec } = recorder((argv) => (argv[0] === "tar" ? { exitCode: 2, stdout: "", stderr: "tar: corrupt" } : ok()));

    await expect(
      prepareWorkspace({ kind: "snapshot", url: "https://files.example.test/a.tgz" }, root, {
        exec,
        fetch: async () => new Response(new Uint8Array([9])),
      }),
    ).rejects.toThrow("snapshot extract failed with exit 2: tar: corrupt");

    expect(existsSync(`${root}.partial.tar.gz`)).toBe(false);
    expect(existsSync(`${root}.partial`)).toBe(false);
    expect(existsSync(root)).toBe(false);
  });
});

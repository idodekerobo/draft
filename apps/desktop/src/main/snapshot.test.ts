import { describe, expect, it, mock } from "bun:test";
import { ServerError } from "draft-core/host/services";
import { SNAPSHOT_MAX_BYTES, listSnapshotEnvFiles, packSnapshot, uploadSnapshot, type SnapshotEntry, type SnapshotFs } from "./snapshot";

const ROOT = "/work/marigold";
const ARCHIVE_DIR = "/tmp/draft-snapshot-test";
const ARCHIVE = `${ARCHIVE_DIR}/snapshot.tar.gz`;
const LIST = `${ARCHIVE_DIR}/members.list`;

type Kind = "file" | "link";

/**
 * An in-memory folder. Keys are paths relative to the root; directories exist where a file lies below them.
 * `archiveBytes` is what the packed archive weighs. `exists` false makes the root not a folder.
 */
function fakeFs(files: Record<string, Kind | number>, options: { archiveBytes?: number; exists?: boolean } = {}) {
  const writes: Record<string, string> = {};
  const removed: string[] = [];
  let temps = 0;
  const fs: SnapshotFs = {
    isDirectory: (path) => (path === ROOT ? options.exists ?? true : false),
    readDirectory: (dir) => {
      const prefix = dir === ROOT ? "" : `${dir.slice(ROOT.length + 1)}/`;
      const entries = new Map<string, "dir" | "file" | "link">();
      for (const [file, value] of Object.entries(files)) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        if (!head) continue;
        if (tail.length > 0) entries.set(head, "dir");
        else entries.set(head, value === "link" ? "link" : "file");
      }
      return [...entries].map(([name, type]): SnapshotEntry => ({
        name,
        isDirectory: () => type === "dir",
        isFile: () => type === "file",
        isSymbolicLink: () => type === "link",
      }));
    },
    fileSize: (path) => (path === ARCHIVE ? (options.archiveBytes ?? 1024) : 1),
    makeTempDirectory: () => {
      temps += 1;
      return temps === 1 ? ARCHIVE_DIR : `${ARCHIVE_DIR}-${temps}`;
    },
    writeText: (path, text) => {
      writes[path] = text;
    },
    remove: (path) => {
      removed.push(path);
    },
  };
  return { fs, writes, removed };
}

/** A tar that succeeds unless told otherwise. It records each argv and the directory it ran in. */
function fakeExec(exitCode = 0) {
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  const exec = mock(async (argv: string[], options: { cwd: string; timeoutMs: number }) => {
    calls.push({ argv, cwd: options.cwd });
    return { exitCode, stderr: exitCode === 0 ? "" : "tar: boom" };
  });
  return { exec, calls };
}

/** The members the pack asked tar to archive, from the NUL-separated list it wrote. */
const members = (writes: Record<string, string>) => writes[LIST]!.split("\0");

const TREE: Record<string, Kind | number> = {
  "package.json": 120,
  "src/index.ts": 300,
  "src/lib/util.ts": 80,
  ".git/HEAD": 20,
  "node_modules/left-pad/index.js": 900,
  ".env": 40,
  ".env.local": 40,
  "apps/web/.env.production": 40,
  "apps/web/src/app.ts": 60,
  "docs/readme.md": 30,
  "docs/current": "link",
};

describe("listSnapshotEnvFiles", () => {
  it("lists every .env* file, top-level and nested, and skips node_modules and .git", () => {
    const { fs } = fakeFs(TREE);
    expect(listSnapshotEnvFiles(ROOT, fs)).toEqual({ ok: true, files: [".env", ".env.local", "apps/web/.env.production"] });
  });

  it("does not list files that merely mention env", () => {
    const { fs } = fakeFs({ "env.example": 10, "config/environment.ts": 10, "README.md": 10 });
    expect(listSnapshotEnvFiles(ROOT, fs)).toEqual({ ok: true, files: [] });
  });

  it("refuses a path that is not a folder", () => {
    const { fs } = fakeFs(TREE, { exists: false });
    expect(listSnapshotEnvFiles(ROOT, fs)).toEqual({ ok: false, error: "not_a_folder" });
  });
});

describe("packSnapshot", () => {
  it("packs the listed files with tar, and leaves out .git, node_modules and every unticked .env file", async () => {
    const { fs, writes } = fakeFs(TREE);
    const { exec, calls } = fakeExec();
    const result = await packSnapshot(ROOT, [], { fs, exec });

    expect(result).toEqual({ ok: true, workDir: ARCHIVE_DIR, archive: ARCHIVE, bytes: 1024 });
    expect(calls).toEqual([{ argv: ["tar", "-czf", ARCHIVE, "-C", ROOT, "--null", "-T", LIST], cwd: ROOT }]);
    expect(members(writes).sort()).toEqual(["apps/web/src/app.ts", "docs/current", "docs/readme.md", "package.json", "src/index.ts", "src/lib/util.ts"]);
  });

  it("packs a ticked .env file, and only that one", async () => {
    const { fs, writes } = fakeFs(TREE);
    const { exec } = fakeExec();
    await packSnapshot(ROOT, [".env.local"], { fs, exec });

    expect(members(writes)).toContain(".env.local");
    expect(members(writes)).not.toContain(".env");
    expect(members(writes)).not.toContain("apps/web/.env.production");
  });

  it("never follows a link: a link is listed as itself", async () => {
    const { fs, writes } = fakeFs({ "docs/current": "link", "docs/readme.md": 30 });
    const { exec } = fakeExec();
    await packSnapshot(ROOT, [], { fs, exec });

    expect(members(writes).sort()).toEqual(["docs/current", "docs/readme.md"]);
  });

  it("leaves out a .git file, as a git worktree has", async () => {
    const { fs, writes } = fakeFs({ ".git": 40, "index.ts": 10 });
    const { exec } = fakeExec();
    await packSnapshot(ROOT, [], { fs, exec });

    expect(members(writes)).toEqual(["index.ts"]);
  });

  it("refuses a ticked file that is not an .env file the folder holds, and packs nothing", async () => {
    const { fs } = fakeFs(TREE);
    const { exec } = fakeExec();
    for (const file of ["../secrets.txt", "package.json", ".env.missing"]) {
      expect(await packSnapshot(ROOT, [file], { fs, exec })).toEqual({ ok: false, error: "unknown_env_file" });
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses a folder with nothing to copy, when every file is excluded", async () => {
    const { fs } = fakeFs({ ".env": 10, "node_modules/x.js": 10 });
    const { exec } = fakeExec();
    expect(await packSnapshot(ROOT, [], { fs, exec })).toEqual({ ok: false, error: "snapshot_empty" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses a path that is not a folder", async () => {
    const { fs } = fakeFs(TREE, { exists: false });
    const { exec } = fakeExec();
    expect(await packSnapshot(ROOT, [], { fs, exec })).toEqual({ ok: false, error: "not_a_folder" });
  });

  it("accepts an archive exactly at the cap", async () => {
    const { fs } = fakeFs(TREE, { archiveBytes: SNAPSHOT_MAX_BYTES });
    const { exec } = fakeExec();
    expect(await packSnapshot(ROOT, [], { fs, exec })).toMatchObject({ ok: true, bytes: SNAPSHOT_MAX_BYTES });
  });

  it("refuses an archive over the cap, reports its size, and removes the work directory", async () => {
    const { fs, removed } = fakeFs(TREE, { archiveBytes: SNAPSHOT_MAX_BYTES + 1 });
    const { exec } = fakeExec();
    const result = await packSnapshot(ROOT, [], { fs, exec });

    expect(result).toMatchObject({ ok: false, error: "snapshot_too_large", bytes: SNAPSHOT_MAX_BYTES + 1 });
    expect(result).toMatchObject({ detail: expect.stringContaining("200 MB") });
    expect(removed).toEqual([ARCHIVE_DIR]);
  });

  it("refuses when tar exits non-zero, so an incomplete archive is never uploaded", async () => {
    const { fs, removed } = fakeFs(TREE);
    const { exec } = fakeExec(1);
    expect(await packSnapshot(ROOT, [], { fs, exec })).toEqual({ ok: false, error: "snapshot_pack_failed" });
    expect(removed).toEqual([ARCHIVE_DIR]);
  });

  it("removes the work directory and rethrows when tar cannot run", async () => {
    const { fs, removed } = fakeFs(TREE);
    const exec = mock(async () => { throw new Error("spawn failed"); });
    await expect(packSnapshot(ROOT, [], { fs, exec })).rejects.toThrow("spawn failed");
    expect(removed).toEqual([ARCHIVE_DIR]);
  });
});

describe("uploadSnapshot", () => {
  const link = () => ({ sessionId: "s-1", storageKey: "ws/s-1/seed.tar.gz", signedUrl: "https://storage.test/upload/ws/s-1/seed.tar.gz?token=t" });

  it("asks for a link after packing, PUTs the archive, and returns what the start call needs", async () => {
    const { fs, removed } = fakeFs(TREE);
    const { exec } = fakeExec();
    const order: string[] = [];
    const requestUpload = mock(async () => {
      order.push("requestUpload");
      return link();
    });
    const put = mock(async () => {
      order.push("put");
    });
    const result = await uploadSnapshot(ROOT, [], { fs, exec, put, requestUpload });

    expect(result).toEqual({ ok: true, sessionId: "s-1", storageKey: "ws/s-1/seed.tar.gz", folderName: "marigold", bytes: 1024 });
    expect(order).toEqual(["requestUpload", "put"]);
    expect(put).toHaveBeenCalledWith(link().signedUrl, ARCHIVE, 1024);
    expect(removed).toEqual([ARCHIVE_DIR]);
  });

  it("asks for no link when the folder is over the cap", async () => {
    const { fs, removed } = fakeFs(TREE, { archiveBytes: SNAPSHOT_MAX_BYTES + 1 });
    const { exec } = fakeExec();
    const requestUpload = mock(async () => link());
    const put = mock(async () => {});
    const result = await uploadSnapshot(ROOT, [], { fs, exec, put, requestUpload });

    expect(result).toMatchObject({ ok: false, error: "snapshot_too_large", bytes: SNAPSHOT_MAX_BYTES + 1 });
    expect(requestUpload).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(removed).toEqual([ARCHIVE_DIR]);
  });

  it("reports a failed PUT as snapshot_upload_failed and still removes the work directory", async () => {
    const { fs, removed } = fakeFs(TREE);
    const { exec } = fakeExec();
    const result = await uploadSnapshot(ROOT, [], { fs, exec, requestUpload: async () => link(), put: async () => { throw new Error("snapshot_put_failed_500"); } });

    expect(result).toEqual({ ok: false, error: "snapshot_upload_failed" });
    expect(removed).toEqual([ARCHIVE_DIR]);
  });

  it("passes the server's error code back when the link request is refused", async () => {
    const { fs, removed } = fakeFs(TREE);
    const { exec } = fakeExec();
    const put = mock(async () => {});
    const result = await uploadSnapshot(ROOT, [], { fs, exec, put, requestUpload: async () => { throw new ServerError("seed_upload_url_failed"); } });

    expect(result).toEqual({ ok: false, error: "seed_upload_url_failed" });
    expect(put).not.toHaveBeenCalled();
    expect(removed).toEqual([ARCHIVE_DIR]);
  });

  it("reports a failed pack as snapshot_pack_failed, without asking for a link", async () => {
    const { fs } = fakeFs(TREE);
    const exec = mock(async () => { throw new Error("spawn failed"); });
    const requestUpload = mock(async () => link());
    const result = await uploadSnapshot(ROOT, [], { fs, exec, put: async () => {}, requestUpload });

    expect(result).toEqual({ ok: false, error: "snapshot_pack_failed" });
    expect(requestUpload).not.toHaveBeenCalled();
  });
});

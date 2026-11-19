import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { ServerError } from "draft-core/host/services";

/** The most a snapshot may weigh once packed. The storage bucket enforces the same limit. */
export const SNAPSHOT_MAX_BYTES = 200 * 1024 * 1024;
const PACK_TIMEOUT_MS = 10 * 60_000;
/** The most a folder may hold before packing. Checked first, so a huge folder is refused in seconds, not after minutes of packing. */
export const SNAPSHOT_MAX_RAW_BYTES = 1024 * 1024 * 1024;
/** Never packed, at any depth: git history is rebuilt on the sandbox, and dependencies and build output are recreated. */
const EXCLUDED_NAMES = new Set([".git", "node_modules", ".next", ".turbo", ".venv", "__pycache__"]);

/** A git repository's files: those git tracks or would track, and the ignored files it lists one by one. */
export interface GitListing {
  files: string[];
  ignoredFiles: string[];
}

/** The parts of a directory entry a snapshot reads. Node's Dirent has all of them. */
export interface SnapshotEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/** The file system a snapshot reads and writes. Tests pass a fake; the app passes `nodeSnapshotFs`. */
export interface SnapshotFs {
  isDirectory(path: string): boolean;
  readDirectory(path: string): SnapshotEntry[];
  fileSize(path: string): number;
  makeTempDirectory(): string;
  writeText(path: string, text: string): void;
  remove(path: string): void;
  /** The folder's files as git sees them, or null when it is not in a git repository. Then the folder is walked. */
  gitListing?(path: string): GitListing | null;
  exists?(path: string): boolean;
}

/** Runs `git ls-files` in the folder. Null when git is missing or the folder is not in a repository. */
function nodeGitListing(root: string): GitListing | null {
  const list = (args: string[]): string[] | null => {
    const result = Bun.spawnSync(["git", "-C", root, "ls-files", "-z", ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) return null;
    return result.stdout.toString().split("\0").filter(Boolean);
  };
  const files = list(["--cached", "--others", "--exclude-standard"]);
  if (!files) return null;
  // With --directory an ignored folder comes back as one entry ending in "/", so only loose ignored files are listed.
  const ignored = list(["--others", "--ignored", "--exclude-standard", "--directory"]) ?? [];
  return { files, ignoredFiles: ignored.filter((entry) => !entry.endsWith("/")) };
}

/** Runs a command and returns its exit code. The app passes its `capture`, which never throws on a missing binary. */
export type SnapshotExec = (argv: string[], options: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number; stderr: string }>;

/** Sends the packed archive to the signed link. */
export type PutArchive = (signedUrl: string, archive: string, bytes: number) => Promise<void>;

export const nodeSnapshotFs: SnapshotFs = {
  isDirectory: (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false,
  readDirectory: (path) => readdirSync(path, { withFileTypes: true }),
  fileSize: (path) => statSync(path).size,
  makeTempDirectory: () => mkdtempSync(join(tmpdir(), "draft-snapshot-")),
  writeText: (path, text) => writeFileSync(path, text),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  gitListing: nodeGitListing,
  exists: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
};

export const putArchive: PutArchive = async (signedUrl, archive, bytes) => {
  const response = await fetch(signedUrl, {
    method: "PUT",
    headers: { "content-type": "application/gzip", "x-upsert": "true", "content-length": String(bytes) },
    body: Bun.file(archive),
  });
  if (!response.ok) throw new Error(`snapshot_put_failed_${response.status}`);
};

/** A `.env*` file by name: `.env`, `.env.local`, `.envrc`. The same match as the glob the person sees. */
export const isEnvFileName = (name: string): boolean => name.startsWith(".env");

/**
 * The files under the folder as paths relative to it, with `/` separators. In a git repository this is what git
 * tracks or would track, plus ignored `.env*` files, so ignored build output and nested worktrees stay out.
 * Elsewhere the folder is walked. Symbolic links are listed, not followed.
 */
function folderFiles(root: string, fs: SnapshotFs): string[] {
  const git = fs.gitListing?.(root) ?? null;
  if (git) {
    const kept = (path: string) => !path.split("/").some((part) => EXCLUDED_NAMES.has(part));
    const envIgnored = git.ignoredFiles.filter((path) => isEnvFileName(basename(path)));
    const all = [...new Set([...git.files, ...envIgnored])].filter(kept);
    // git keeps listing a tracked file that was deleted from the folder until the deletion is committed.
    return (fs.exists ? all.filter((path) => fs.exists!(join(root, path))) : all).sort();
  }
  const files: string[] = [];
  const visit = (dir: string, relative: string) => {
    for (const entry of fs.readDirectory(dir)) {
      if (EXCLUDED_NAMES.has(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), path);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
    }
  };
  visit(root, "");
  return files.sort();
}

export type EnvFileListing = { ok: true; files: string[] } | { ok: false; error: "not_a_folder" };

/** The `.env*` files in the folder, nested ones included, with `node_modules` and `.git` skipped. All start unticked. */
export function listSnapshotEnvFiles(root: string, fs: SnapshotFs): EnvFileListing {
  if (!fs.isDirectory(root)) return { ok: false, error: "not_a_folder" };
  return { ok: true, files: folderFiles(root, fs).filter((file) => isEnvFileName(basename(file))) };
}

/** How much a snapshot of the folder would copy, `.env` files aside, so the person can be warned before Start. */
export function snapshotFolderSize(root: string, fs: SnapshotFs): { ok: true; bytes: number; fileCount: number } | { ok: false; error: "not_a_folder" } {
  if (!fs.isDirectory(root)) return { ok: false, error: "not_a_folder" };
  const files = folderFiles(root, fs).filter((file) => !isEnvFileName(basename(file)));
  let bytes = 0;
  for (const file of files) bytes += fs.fileSize(join(root, file));
  return { ok: true, bytes, fileCount: files.length };
}

export type PackResult =
  | { ok: true; workDir: string; archive: string; bytes: number }
  | { ok: false; error: "not_a_folder" | "unknown_env_file" | "snapshot_empty" | "snapshot_pack_failed" | "snapshot_too_large"; bytes?: number; detail?: string };

/**
 * Packs the folder into a tar.gz in a new work directory, which the caller removes. The file list is worked out here,
 * so every exclusion is in this code, and tar archives exactly the listed paths. It never follows a link.
 */
export async function packSnapshot(root: string, includeEnvFiles: string[], deps: { fs: SnapshotFs; exec: SnapshotExec }): Promise<PackResult> {
  const { fs, exec } = deps;
  if (!fs.isDirectory(root)) return { ok: false, error: "not_a_folder" };

  const files = folderFiles(root, fs);
  const envFiles = new Set(files.filter((file) => isEnvFileName(basename(file))));
  if (includeEnvFiles.some((file) => !envFiles.has(file))) return { ok: false, error: "unknown_env_file" };
  const included = new Set(includeEnvFiles);
  const members = files.filter((file) => !envFiles.has(file) || included.has(file));
  if (members.length === 0) return { ok: false, error: "snapshot_empty" };
  let rawBytes = 0;
  for (const file of members) rawBytes += fs.fileSize(join(root, file));
  if (rawBytes > SNAPSHOT_MAX_RAW_BYTES) return { ok: false, error: "snapshot_too_large", bytes: rawBytes, detail: snapshotTooLargeMessage(rawBytes, "holds") };

  const workDir = fs.makeTempDirectory();
  const list = join(workDir, "members.list");
  const archive = join(workDir, "snapshot.tar.gz");
  try {
    fs.writeText(list, members.join("\0"));
    const result = await exec(["tar", "-czf", archive, "-C", root, "--null", "-T", list], { cwd: root, timeoutMs: PACK_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      console.error("snapshot: tar failed", result.exitCode, result.stderr.slice(-300));
      fs.remove(workDir);
      return { ok: false, error: "snapshot_pack_failed" };
    }
    const bytes = fs.fileSize(archive);
    if (bytes > SNAPSHOT_MAX_BYTES) {
      fs.remove(workDir);
      return { ok: false, error: "snapshot_too_large", bytes, detail: snapshotTooLargeMessage(bytes) };
    }
    return { ok: true, workDir, archive, bytes };
  } catch (error) {
    fs.remove(workDir);
    throw error;
  }
}

export function snapshotTooLargeMessage(bytes: number, verb: "packs to" | "holds" = "packs to"): string {
  const megabytes = (bytes / (1024 * 1024)).toFixed(1);
  const limit = verb === "holds" ? "1 GB before packing" : "200 MB packed";
  return `This folder ${verb} ${megabytes} MB. Snapshots are limited to ${limit}, so move large files out of the folder, add them to .gitignore, or use a GitHub repository.`;
}

export interface SnapshotUpload {
  sessionId: string;
  storageKey: string;
  signedUrl: string;
}

export interface UploadSnapshotDeps {
  fs: SnapshotFs;
  exec: SnapshotExec;
  put: PutArchive;
  /** Asks the server for the session id and a signed link. Called only after the folder packed within the cap. */
  requestUpload(): Promise<SnapshotUpload>;
}

export type SnapshotUploadResult =
  | { ok: true; sessionId: string; storageKey: string; folderName: string; bytes: number }
  | { ok: false; error: string; bytes?: number; detail?: string };

/** Packs the folder, asks for an upload link, sends the archive, and removes the work directory. */
export async function uploadSnapshot(root: string, includeEnvFiles: string[], deps: UploadSnapshotDeps): Promise<SnapshotUploadResult> {
  let packed: PackResult;
  try {
    packed = await packSnapshot(root, includeEnvFiles, deps);
  } catch (error) {
    console.error("snapshot: packing failed", error);
    return { ok: false, error: "snapshot_pack_failed" };
  }
  if (!packed.ok) return packed;
  const { workDir, archive, bytes } = packed;

  try {
    const upload = await deps.requestUpload();
    await deps.put(upload.signedUrl, archive, bytes);
    return { ok: true, sessionId: upload.sessionId, storageKey: upload.storageKey, folderName: basename(root), bytes };
  } catch (error) {
    console.error("snapshot: upload failed", error);
    return { ok: false, error: error instanceof ServerError ? error.code : "snapshot_upload_failed" };
  } finally {
    deps.fs.remove(workDir);
  }
}

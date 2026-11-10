import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readOutputSchema(path: string, inputRoot = "/run/input"): string {
  const resolvedPath = resolve(path);
  if (!resolvedPath.startsWith(`${resolve(inputRoot)}/`) || !existsSync(resolvedPath)) {
    throw new Error("DRAFT_OUTPUT_SCHEMA_PATH must name a file beneath /run/input");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolvedPath, "utf8"));
  } catch {
    throw new Error("DRAFT_OUTPUT_SCHEMA_PATH must contain valid JSON");
  }
  if (!isObject(parsed)) {
    throw new Error("DRAFT_OUTPUT_SCHEMA_PATH must contain a JSON object");
  }
  return JSON.stringify(parsed);
}

export function secureInputTree(path: string): { fileCount: number; totalBytes: number } {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("input tree must not contain symlinks");
  if (stat.uid !== 0 || stat.gid !== 0) chownSync(path, 0, 0);
  chmodSync(path, stat.isDirectory() ? 0o555 : 0o444);
  let fileCount = stat.isDirectory() ? 0 : 1;
  let totalBytes = stat.isDirectory() ? 0 : stat.size;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      const child = secureInputTree(join(path, entry));
      fileCount += child.fileCount;
      totalBytes += child.totalBytes;
    }
  }
  return { fileCount, totalBytes };
}

export function assertWithinInputRoot(target: string, inputRoot: string, path: string): void {
  const resolvedRoot = resolve(inputRoot);
  const resolvedTarget = resolve(target);
  if (!resolvedTarget.startsWith(`${resolvedRoot}/`)) {
    throw new Error(`bundle file path escapes input root: ${path}`);
  }
}

export function recomputeBundleHash(
  files: Record<string, string>,
  reservedPaths: ReadonlySet<string>,
): string {
  const entries = Object.entries(files)
    .filter(([path]) => !reservedPaths.has(path))
    .map(([path, content]) => {
      const bytes = Buffer.from(content, "utf8");
      return [path, createHash("sha256").update(bytes).digest("hex"), bytes.byteLength] as const;
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export async function fetchAndWriteBundle(
  bundleUrl: string,
  bundleHash: string,
  inputRoot: string,
  bundleRoot: string,
  reservedPaths: ReadonlySet<string>,
): Promise<void> {
  const response = await fetch(bundleUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`bundle fetch returned HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!isObject(payload) || !isObject(payload.files)) {
    throw new Error("bundle payload must be a JSON object with a files map");
  }
  const downloadedFiles = payload.files as Record<string, string>;
  for (const [path, content] of Object.entries(downloadedFiles)) {
    if (typeof content !== "string") throw new Error(`bundle file content must be a string: ${path}`);
  }

  const recomputedHash = recomputeBundleHash(downloadedFiles, reservedPaths);
  if (recomputedHash !== bundleHash) {
    throw new Error("bundle content does not match DRAFT_BUNDLE_HASH");
  }

  // Bundle keys (e.g. "input/prompt.md") already carry the "input/" segment,
  // so they're relative to bundleRoot (/run), not inputRoot (/run/input) —
  // joining against inputRoot would double it to /run/input/input/....
  for (const [path, content] of Object.entries(downloadedFiles)) {
    const target = join(bundleRoot, path);
    assertWithinInputRoot(target, inputRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

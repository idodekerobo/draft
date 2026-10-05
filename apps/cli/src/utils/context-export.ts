// utils/context-export.ts — validate and extract the context export zip

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { strFromU8, unzipSync } from "fflate";

const WRAPPER = "draft-context/";

export class ContextExportError extends Error {
  constructor(readonly code: "invalid_zip" | "unsafe_entry" | "folder_not_empty" | "file_exists", message: string) {
    super(message);
  }
}

export interface ExportEntry {
  path: string;
  data: Uint8Array;
}

function safeEntryPath(name: string): string | null {
  if (!name.startsWith(WRAPPER)) return null;
  const rel = name.slice(WRAPPER.length);
  if (rel === "" || rel.includes("\\") || rel.includes("\0") || rel.startsWith("/")) return null;
  const segments = rel.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return rel;
}

/** Validates every entry before returning any, so a bad zip writes nothing. */
export function readExportEntries(bytes: Uint8Array): ExportEntry[] {
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes);
  } catch {
    throw new ContextExportError("invalid_zip", "The export is not a valid zip file.");
  }

  const entries: ExportEntry[] = [];
  for (const [name, data] of Object.entries(raw)) {
    if (name.endsWith("/")) continue;
    const path = safeEntryPath(name);
    if (!path) throw new ContextExportError("unsafe_entry", `The export has an unsafe path: ${name}`);
    entries.push({ path, data });
  }
  return entries;
}

export function exportVersionNumber(entries: ExportEntry[]): number | null {
  const manifest = entries.find((entry) => entry.path === "draft-export.json");
  if (!manifest) return null;
  try {
    const parsed = JSON.parse(strFromU8(manifest.data)) as { versionNumber?: unknown };
    return typeof parsed.versionNumber === "number" ? parsed.versionNumber : null;
  } catch {
    return null;
  }
}

export function writeExportFolder(entries: ExportEntry[], outDir: string, force: boolean): void {
  const root = resolve(outDir);
  if (!force && existsSync(root) && readdirSync(root).length > 0) {
    throw new ContextExportError("folder_not_empty", `${outDir} is not empty. Use --force to write into it.`);
  }
  for (const entry of entries) {
    const target = join(root, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
}

export function writeExportZip(bytes: Uint8Array, file: string, force: boolean): void {
  const target = resolve(file);
  if (!force && existsSync(target)) {
    throw new ContextExportError("file_exists", `${file} already exists. Use --force to overwrite it.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

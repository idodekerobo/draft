import { strToU8, zipSync } from "fflate";
import { assertSafeDocumentPath } from "../synthesis/context-version-files";
import type { WorkspaceContextSnapshot } from "./workspace-context";

export const EXPORT_FOLDER = "draft-context";

export interface ExportFile {
  path: string;
  content: string;
}

function buildReadme(snapshot: WorkspaceContextSnapshot, paths: string[]): string {
  const roots = [...new Set(paths.map((path) => (path.includes("/") ? path.split("/")[0] : "")))]
    .filter(Boolean)
    .sort();
  return [
    "# Draft context export",
    "",
    `Version ${snapshot.versionNumber}. This folder is a plain-markdown copy of your company brain from Draft.`,
    "",
    "## Layout",
    "- Each top-level folder is one context dimension. Start with its `index.md`.",
    ...roots.map((root) => `- \`${root}/\``),
    "- `draft-export.json` has the version, content hash and export time.",
    "",
    "## Use with an agent",
    "Open an agent (Claude Code, Codex, OpenCode) in this folder and tell it to read `README.md`",
    "and the `index.md` files first. Treat these files as read-only reference.",
    "",
    "This is a copy. Anyone with these files can read them.",
    "",
  ].join("\n");
}

export function buildExportFiles(snapshot: WorkspaceContextSnapshot, now = new Date()): ExportFile[] {
  const files = Object.entries(snapshot.documents).map(([path, document]) => {
    assertSafeDocumentPath(path);
    return { path, content: document.content };
  });
  const manifest = {
    versionNumber: snapshot.versionNumber,
    versionId: snapshot.versionId,
    contentHash: snapshot.contentHash,
    exportedAt: now.toISOString(),
  };
  return [
    { path: "README.md", content: buildReadme(snapshot, files.map((file) => file.path)) },
    { path: "draft-export.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    ...files,
  ];
}

export function buildExportZip(files: ExportFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) entries[`${EXPORT_FOLDER}/${file.path}`] = strToU8(file.content);
  return zipSync(entries);
}

export function exportFileName(versionNumber: number, now = new Date()): string {
  return `draft-context-v${versionNumber}-${now.toISOString().slice(0, 10)}.zip`;
}

export function buildContextExport(
  snapshot: WorkspaceContextSnapshot,
  now = new Date(),
): { fileName: string; bytes: Uint8Array } {
  return { fileName: exportFileName(snapshot.versionNumber, now), bytes: buildExportZip(buildExportFiles(snapshot, now)) };
}

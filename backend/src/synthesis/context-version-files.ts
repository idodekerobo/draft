import { createHash } from "node:crypto";
import type {
  SourceItemRow,
  SynthesisRunRow,
  SynthesisRunSourceItemRow,
  WorkspaceContextVersionRow,
} from "../types/tables";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MARKDOWN_PATH_SEGMENT_PATTERN =
  /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export type ContextDocuments = WorkspaceContextVersionRow["documents_json"];

export interface RunBundleIdentity {
  organizationId: string;
  teamId: string;
  workspaceId: string;
}

export interface RunBundleLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
}

export interface RunBundleSource {
  item: Pick<
    SourceItemRow,
    | "id"
    | "workspace_id"
    | "external_version"
    | "content_markdown"
    | "content_hash"
  >;
  membership: Pick<
    SynthesisRunSourceItemRow,
    | "workspace_id"
    | "synthesis_run_id"
    | "source_item_id"
    | "source_item_version"
    | "content_hash"
    | "position"
  >;
}

export interface RunBundleFile {
  content: string;
  sha256: string;
  bytes: number;
}

export interface ValidatedRunBundle {
  organizationId: string;
  teamId: string;
  workspaceId: string;
  runId: string;
  baseContextVersionId: string;
  promptVersion: string;
  files: Record<string, RunBundleFile>;
  totalBytes: number;
  bundleHash: string;
  outputPath: "output/result.json";
}

export interface BuildRunBundleInput {
  identity: RunBundleIdentity;
  run: Pick<
    SynthesisRunRow,
    "id" | "workspace_id" | "base_context_version_id" | "prompt_version"
  >;
  baseVersion: WorkspaceContextVersionRow;
  sources: RunBundleSource[];
  limits: RunBundleLimits;
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function utf8Bytes(content: string, label: string): Uint8Array {
  const bytes = new TextEncoder().encode(content);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (decoded !== content) {
    throw new Error(`${label} must be valid UTF-8`);
  }
  return bytes;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256`);
  }
}

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

export function assertSafeDocumentPath(path: string): void {
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    !path.endsWith(".md") ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        !MARKDOWN_PATH_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new Error(`document path must be a safe relative Markdown path: ${path}`);
  }
}

function canonicalDocuments(documents: ContextDocuments): ContextDocuments {
  if (typeof documents !== "object" || documents === null || Array.isArray(documents)) {
    throw new Error("documents must be an object");
  }

  const entries: Array<[string, { content: string; sha256: string }]> = [];
  for (const path of Object.keys(documents).sort()) {
    const document = documents[path] as unknown;
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      throw new Error(`document must be an object: ${path}`);
    }
    const fields = Object.keys(document);
    if (
      fields.length !== 2 ||
      !fields.includes("content") ||
      !fields.includes("sha256")
    ) {
      throw new Error(`document must contain only content and sha256: ${path}`);
    }
    const { content, sha256: documentHash } = document as Record<string, unknown>;
    if (typeof content !== "string") {
      throw new Error(`document content must be a string: ${path}`);
    }
    if (typeof documentHash !== "string") {
      throw new Error(`document sha256 must be lowercase SHA-256: ${path}`);
    }
    assertSha256(documentHash, `document sha256: ${path}`);
    entries.push([path, { content, sha256: documentHash }]);
  }
  return Object.fromEntries(entries);
}

export function canonicalDocumentsHash(documents: ContextDocuments): string {
  return sha256(JSON.stringify(canonicalDocuments(documents)));
}

function addFile(
  entries: Array<[string, RunBundleFile]>,
  path: string,
  content: string,
  limits: RunBundleLimits,
): void {
  const bytes = utf8Bytes(content, path);
  if (bytes.byteLength > limits.maxFileBytes) {
    throw new Error(`bundle file exceeds maxFileBytes: ${path}`);
  }
  entries.push([
    path,
    { content, sha256: sha256(bytes), bytes: bytes.byteLength },
  ]);
}

function runMetadataBytes(input: BuildRunBundleInput, sources: RunBundleSource[]): string {
  const metadata = {
    schema_version: 1,
    organization_id: input.identity.organizationId,
    team_id: input.identity.teamId,
    workspace_id: input.identity.workspaceId,
    run_id: input.run.id,
    base_context_version_id: input.baseVersion.id,
    base_context_version_number: input.baseVersion.version_number,
    base_context_content_hash: input.baseVersion.content_hash,
    prompt_version: input.run.prompt_version,
    context_documents: Object.keys(input.baseVersion.documents_json)
      .sort()
      .map((path) => ({
        logical_path: path,
        read_path: `input/context/${path}`,
        sha256: input.baseVersion.documents_json[path].sha256,
      })),
    sources: sources.map(({ item, membership }) => ({
      source_item_id: item.id,
      source_item_version: membership.source_item_version,
      position: membership.position,
      read_path: `input/sources/${String(membership.position).padStart(4, "0")}-${item.id}.md`,
      sha256: membership.content_hash,
    })),
    output_path: "output/result.json",
  };
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

/**
 * Build the complete deterministic input for one isolated synthesis sandbox.
 * This function is pure: it performs no database, network, or filesystem I/O.
 */
export function buildValidatedRunBundle(
  input: BuildRunBundleInput,
): ValidatedRunBundle {
  const { identity, run, baseVersion, limits } = input;
  assertPositiveLimit(limits.maxFileBytes, "maxFileBytes");
  assertPositiveLimit(limits.maxTotalBytes, "maxTotalBytes");
  assertUuid(identity.organizationId, "organizationId");
  assertUuid(identity.teamId, "teamId");
  assertUuid(identity.workspaceId, "workspaceId");
  assertUuid(run.id, "run.id");
  assertUuid(baseVersion.id, "baseVersion.id");

  if (run.workspace_id !== identity.workspaceId) {
    throw new Error("run workspace does not match bundle identity");
  }
  if (baseVersion.workspace_id !== identity.workspaceId) {
    throw new Error("base version workspace does not match bundle identity");
  }
  if (run.base_context_version_id !== baseVersion.id) {
    throw new Error("run base version does not match supplied context version");
  }
  if (!run.prompt_version) throw new Error("run.prompt_version is required");
  assertSha256(baseVersion.content_hash, "baseVersion.content_hash");

  const documents = canonicalDocuments(baseVersion.documents_json);
  if (canonicalDocumentsHash(documents) !== baseVersion.content_hash) {
    throw new Error("base version content_hash does not match documents_json");
  }

  const files: Array<[string, RunBundleFile]> = [];
  for (const path of Object.keys(documents)) {
    assertSafeDocumentPath(path);
    const document = documents[path];
    const bytes = utf8Bytes(document.content, path);
    if (sha256(bytes) !== document.sha256) {
      throw new Error(`document sha256 does not match content: ${path}`);
    }
    addFile(files, `input/context/${path}`, document.content, limits);
  }

  const sources = [...input.sources].sort(
    (left, right) => left.membership.position - right.membership.position,
  );
  const positions = new Set<number>();
  const sourceIds = new Set<string>();
  for (const [expectedPosition, { item, membership }] of sources.entries()) {
    assertUuid(item.id, "source item id");
    if (positions.has(membership.position) || membership.position !== expectedPosition) {
      throw new Error("source membership positions must be unique and contiguous from zero");
    }
    if (sourceIds.has(item.id)) throw new Error(`duplicate source item: ${item.id}`);
    positions.add(membership.position);
    sourceIds.add(item.id);

    if (
      item.workspace_id !== identity.workspaceId ||
      membership.workspace_id !== identity.workspaceId
    ) {
      throw new Error(`source item workspace does not match bundle: ${item.id}`);
    }
    if (membership.synthesis_run_id !== run.id) {
      throw new Error(`source membership run does not match bundle: ${item.id}`);
    }
    if (membership.source_item_id !== item.id) {
      throw new Error(`source membership item does not match source row: ${item.id}`);
    }
    if (membership.source_item_version !== item.external_version) {
      throw new Error(`source membership version does not match source row: ${item.id}`);
    }
    if (item.content_markdown === null || item.content_hash === null) {
      throw new Error(`source item must have normalized Markdown and hash: ${item.id}`);
    }
    assertSha256(item.content_hash, `source item content_hash: ${item.id}`);
    assertSha256(membership.content_hash, `source membership content_hash: ${item.id}`);
    const sourceBytes = utf8Bytes(item.content_markdown, `source item ${item.id}`);
    const sourceHash = sha256(sourceBytes);
    if (sourceHash !== item.content_hash || sourceHash !== membership.content_hash) {
      throw new Error(`source item hash does not match exact content: ${item.id}`);
    }
    addFile(
      files,
      `input/sources/${String(membership.position).padStart(4, "0")}-${item.id}.md`,
      item.content_markdown,
      limits,
    );
  }

  addFile(files, "input/run.json", runMetadataBytes(input, sources), limits);
  files.sort(([left], [right]) => left.localeCompare(right));
  const fileMap = Object.fromEntries(files);
  const totalBytes = files.reduce((sum, [, file]) => sum + file.bytes, 0);
  if (totalBytes > limits.maxTotalBytes) {
    throw new Error("bundle exceeds maxTotalBytes");
  }
  const bundleHash = sha256(
    JSON.stringify(files.map(([path, file]) => [path, file.sha256, file.bytes])),
  );

  return {
    organizationId: identity.organizationId,
    teamId: identity.teamId,
    workspaceId: identity.workspaceId,
    runId: run.id,
    baseContextVersionId: baseVersion.id,
    promptVersion: run.prompt_version,
    files: fileMap,
    totalBytes,
    bundleHash,
    outputPath: "output/result.json",
  };
}

import { readFileSync, statSync } from "fs";
import { gzipSync } from "zlib";
import type { RawUploadRecord } from "./cursor-store";

export interface RawUploadDeps {
  requestUrls: (files: string[]) => Promise<Array<{ file: string; signedUrl: string }>>;
  put: (signedUrl: string, gzipped: Uint8Array) => Promise<void>;
  complete: () => Promise<void>;
}

export interface RawFile {
  label: string;
  path: string;
}

function changed(file: RawFile, records: Record<string, RawUploadRecord>): boolean {
  const stat = statSync(file.path);
  const previous = records[file.label];
  return !previous || previous.size !== stat.size || previous.mtimeMs < stat.mtimeMs;
}

/** Uploads the files that are new or newer than their last upload, and returns the updated records. */
export async function uploadRawFiles(
  files: RawFile[],
  records: Record<string, RawUploadRecord>,
  deps: RawUploadDeps,
): Promise<Record<string, RawUploadRecord>> {
  const pending = files.filter((file) => changed(file, records));
  if (pending.length === 0) return records;

  // Stat before reading, so a write that lands during the upload is picked up next time.
  const stats = new Map(pending.map((file) => [file.label, statSync(file.path)]));
  const urls = await deps.requestUrls(pending.map((file) => file.label));
  for (const file of pending) {
    const target = urls.find((u) => u.file === file.label);
    if (!target) throw new Error(`raw_upload_url_missing: ${file.label}`);
    await deps.put(target.signedUrl, gzipSync(readFileSync(file.path)));
  }
  await deps.complete();

  const next = { ...records };
  for (const file of pending) {
    const stat = stats.get(file.label)!;
    next[file.label] = { size: stat.size, mtimeMs: stat.mtimeMs };
  }
  return next;
}

export async function putSigned(signedUrl: string, gzipped: Uint8Array): Promise<void> {
  const response = await fetch(signedUrl, {
    method: "PUT",
    headers: { "content-type": "application/gzip", "x-upsert": "true" },
    body: Buffer.from(gzipped),
  });
  if (!response.ok) throw new Error(`raw_upload_put_failed_${response.status}`);
}

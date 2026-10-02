import { createHash } from "node:crypto";

// Must stay byte-for-byte identical to recomputeBundleHash in
// claude-code/runner.ts, which verifies downloaded bundles against this value.
// The runner ships in its own image and cannot import this module.
export function computeBundleHash(files: Record<string, string>): string {
  const entries = Object.entries(files)
    .map(([path, content]) => {
      const bytes = Buffer.from(content, "utf8");
      return [path, createHash("sha256").update(bytes).digest("hex"), bytes.byteLength] as const;
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

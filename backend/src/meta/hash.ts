import { createHash } from "node:crypto";

// Meta matches on sha256 of the trimmed, lowercased value.
export function hashForMeta(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase(), "utf8").digest("hex");
}

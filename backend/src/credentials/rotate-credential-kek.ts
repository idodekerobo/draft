// Re-encrypts credentials.encrypted_payload from one KEK version to another. Run:
//   bun --env-file=.env.staging run backend/src/credentials/rotate-credential-kek.ts \
//     --from=v1 --to=v2 [--dry-run]
//
// Needs INFERENCE_CREDENTIAL_KEK_<FROM> and INFERENCE_CREDENTIAL_KEK_<TO> in the
// env. Safe to re-run: each update only matches rows still on the `from`
// version. Logs counts and row ids only, never plaintext or keys.

import { decryptCredentialPayload, encryptCredentialPayload } from "./crypto";
import { serviceClient } from "../db/client";

const BATCH_SIZE = 200;

interface Arguments {
  from: string;
  to: string;
  dryRun: boolean;
}

function parseArguments(): Arguments {
  let from: string | undefined;
  let to: string | undefined;
  let dryRun = false;
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith("--from=")) from = argument.slice("--from=".length);
    else if (argument.startsWith("--to=")) to = argument.slice("--to=".length);
    else if (argument === "--dry-run") dryRun = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!from || !to) throw new Error("missing required arguments --from=<version> --to=<version>");
  if (from === to) throw new Error("--from and --to must differ");
  return { from, to, dryRun };
}

async function main(): Promise<void> {
  const { from, to, dryRun } = parseArguments();

  let lastId: string | null = null;
  let scanned = 0;
  let rotated = 0;
  const failedIds: string[] = [];

  for (;;) {
    let query = serviceClient
      .from("credentials")
      .select("id, encrypted_payload")
      .eq("encryption_key_version", from)
      .order("id", { ascending: true })
      .limit(BATCH_SIZE);
    if (lastId) query = query.gt("id", lastId);

    const { data: rows, error } = await query;
    if (error) throw error;
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      lastId = row.id;
      try {
        const plaintext = decryptCredentialPayload(row.encrypted_payload, from);
        const reencrypted = encryptCredentialPayload(plaintext, to);
        if (decryptCredentialPayload(reencrypted, to) !== plaintext) {
          throw new Error("round-trip mismatch");
        }
        if (dryRun) {
          rotated += 1;
          continue;
        }
        const { data: updated, error: updateError } = await serviceClient
          .from("credentials")
          .update({ encrypted_payload: reencrypted, encryption_key_version: to })
          .eq("id", row.id)
          .eq("encryption_key_version", from)
          .select("id");
        if (updateError) throw updateError;
        if (updated && updated.length > 0) rotated += 1;
      } catch {
        failedIds.push(row.id);
      }
    }
  }

  const verb = dryRun ? "would rotate" : "rotated";
  console.log(`${verb} ${rotated}/${scanned} credentials from ${from} to ${to}`);
  if (failedIds.length > 0) {
    console.error(`failed ${failedIds.length} rows: ${failedIds.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

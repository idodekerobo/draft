#!/usr/bin/env bun
// One-off helper for a GitHub App private key downloaded manually from the
// GitHub UI (as opposed to scripts/create-github-app.ts's manifest flow,
// which does this conversion automatically). GitHub always hands out
// PKCS#1 ("BEGIN RSA PRIVATE KEY"); jose's importPKCS8 (used by
// backend/src/ingestion/github/client.ts) needs PKCS#8 ("BEGIN PRIVATE
// KEY") -- a real re-encoding, not just swapping the header/footer text.
//
//   bun run scripts/convert-github-app-key.ts /path/to/downloaded-key.pem

import { createPrivateKey } from "node:crypto";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: bun run scripts/convert-github-app-key.ts /path/to/downloaded-key.pem");
  process.exit(1);
}

const pkcs1Pem = await Bun.file(inputPath).text();

const pkcs8Pem = createPrivateKey({ key: pkcs1Pem, format: "pem" })
  .export({ type: "pkcs8", format: "pem" })
  .toString();

const oneLine = pkcs8Pem.replace(/\r?\n/g, "\\n");

console.log("\nConverted to PKCS#8. Paste this into the root .env.local:\n");
console.log(`GITHUB_APP_PRIVATE_KEY="${oneLine}"`);

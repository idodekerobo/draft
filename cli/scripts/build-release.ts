#!/usr/bin/env bun
// cli/scripts/build-release.ts — cross-compiles `draft` for every platform,
// named to match platformAssetName() in commands/update.ts. Called from
// `make desktop-release` to ship these as extra assets on the same release.
//
// Required env: DRAFT_SUPABASE_URL, DRAFT_SUPABASE_PUBLISHABLE_KEY,
// DRAFT_CLI_VERSION. Optional: OUTPUT_DIR (default: ../desktop/artifacts).

const required = ["DRAFT_SUPABASE_URL", "DRAFT_SUPABASE_PUBLISHABLE_KEY", "DRAFT_CLI_VERSION"] as const;
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`build-release failed: missing required env var(s): ${missing.join(", ")}`);
  process.exit(1);
}

const supabaseUrl = process.env.DRAFT_SUPABASE_URL!;
const supabasePublishableKey = process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY!;
const cliVersion = process.env.DRAFT_CLI_VERSION!;
const cliRoot = import.meta.dir + "/..";
const outputDir = process.env.OUTPUT_DIR ?? `${cliRoot}/../desktop/artifacts`;

// assetName must match platformAssetName() in commands/update.ts exactly.
const TARGETS = [
  { bunTarget: "bun-darwin-arm64", assetName: "stable-macos-arm64-draft-cli" },
  { bunTarget: "bun-darwin-x64",   assetName: "stable-macos-x64-draft-cli" },
  { bunTarget: "bun-linux-x64",    assetName: "stable-linux-x64-draft-cli" },
] as const;

await Bun.spawn(["mkdir", "-p", outputDir]).exited;

for (const { bunTarget, assetName } of TARGETS) {
  console.log(`[build-release] Compiling ${assetName} (${bunTarget})...`);
  const proc = Bun.spawn({
    cmd: [
      "bun", "build", "--compile",
      "--target", bunTarget,
      "--define", `process.env.DRAFT_SUPABASE_URL=${JSON.stringify(supabaseUrl)}`,
      "--define", `process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY=${JSON.stringify(supabasePublishableKey)}`,
      "--define", `process.env.DRAFT_CLI_VERSION=${JSON.stringify(cliVersion)}`,
      "src/index.ts", "--outfile", `${outputDir}/${assetName}`,
    ],
    cwd: cliRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`[build-release] Failed compiling ${assetName}`);
    process.exit(exitCode);
  }
}

console.log(`[build-release] Done — ${TARGETS.length} binaries in ${outputDir}`);

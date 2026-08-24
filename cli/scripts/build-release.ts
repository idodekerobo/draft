#!/usr/bin/env bun
// cli/scripts/build-release.ts — cross-compiles `draft` for every platform,
// named to match platformAssetName() in commands/update.ts. Called from
// `make desktop-release` to ship these as extra assets on the same release.
//
// Required env: DRAFT_SUPABASE_URL, DRAFT_SUPABASE_PUBLISHABLE_KEY,
// DRAFT_CLI_VERSION. Optional: OUTPUT_DIR (default: ../desktop/artifacts).

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { capture } from "draft-core/exec";

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

// Only the target matching this host's platform/arch can actually be
// executed here (Bun cross-compiles but can't run a foreign-arch binary) —
// other targets are smoke-tested by compilation success alone.
function hostMatchesBunTarget(bunTarget: string): boolean {
  if (bunTarget === "bun-darwin-arm64") return process.platform === "darwin" && process.arch === "arm64";
  if (bunTarget === "bun-darwin-x64") return process.platform === "darwin" && process.arch === "x64";
  if (bunTarget === "bun-linux-x64") return process.platform === "linux" && process.arch === "x64";
  return false;
}

// Runs the compiled binary from an empty cwd/HOME with no source tree and no
// stored auth, proving: (1) the CLI starts and its help mentions
// `integrations` without needing any files on disk beyond the binary itself
// (verifies the Slack manifest and other compile-time JSON imports are truly
// embedded, not read from a relative path at runtime); (2) a real command
// (`integrations list`) runs cleanly unauthenticated, without crashing or
// printing anything secret, since there's nothing secret to print yet.
async function smokeTest(binaryPath: string, assetName: string): Promise<void> {
  console.log(`[build-release] Smoke-testing ${assetName}...`);
  const emptyCwd = mkdtempSync(join(tmpdir(), "draft-smoke-cwd-"));
  const emptyHome = mkdtempSync(join(tmpdir(), "draft-smoke-home-"));
  const runOpts = { cwd: emptyCwd, env: { HOME: emptyHome }, timeoutMs: 10_000 };
  try {
    const help = await capture([binaryPath, "--help"], runOpts);
    if (help.exitCode !== 0 || !help.stdout.includes("integrations")) {
      throw new Error(`--help failed or didn't mention integrations (exit ${help.exitCode}): ${help.stdout}${help.stderr}`);
    }

    const list = await capture([binaryPath, "integrations", "list", "--json"], runOpts);
    const listPayload = JSON.parse(list.stdout);
    if (list.exitCode !== 1 || listPayload.status !== "error" || listPayload.code !== "not_authenticated") {
      throw new Error(`unauthenticated 'integrations list' didn't fail cleanly with not_authenticated (exit ${list.exitCode}): ${list.stdout}`);
    }

    // --credential-stdin forces the automation credential path (reads from fd
    // 0, never opens /dev/tty) so this can't block even when the build script
    // itself has a real controlling terminal attached — `capture()`'s default
    // "ignore" stdin (fd 0 -> /dev/null) hits EOF immediately and the command
    // fails fast on invalid_credential_input, but only after emitting the
    // manifest-derived browser_required line first, which is what this checks.
    const slack = await capture([binaryPath, "integrations", "connect", "slack", "--no-open", "--credential-stdin", "--json"], runOpts);
    const slackPayload = JSON.parse(slack.stdout.trim().split("\n")[0]!);
    if (
      slackPayload.status !== "browser_required" ||
      slackPayload.provider !== "slack" ||
      typeof slackPayload.url !== "string" ||
      !slackPayload.url.startsWith("https://api.slack.com/apps?new_app=1&manifest_json=")
    ) {
      throw new Error(`'integrations connect slack --no-open' didn't emit a valid manifest URL from a directory with no source tree: ${slack.stdout}`);
    }
  } finally {
    rmSync(emptyCwd, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  }
  console.log(`[build-release] Smoke test passed for ${assetName}`);
}

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

  if (hostMatchesBunTarget(bunTarget)) {
    try {
      await smokeTest(`${outputDir}/${assetName}`, assetName);
    } catch (error) {
      console.error(`[build-release] Smoke test failed for ${assetName}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  } else {
    console.log(`[build-release] Skipping smoke test for ${assetName} — cannot execute a foreign-arch binary on this host`);
  }
}

console.log(`[build-release] Done — ${TARGETS.length} binaries in ${outputDir}`);

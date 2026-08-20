// commands/update.ts — draft update, plus the background staleness check
//
// CLI binaries ship as extra assets on the same GitHub release as the
// desktop app (see make desktop-release) — one version, one place to look.

import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { capture } from "draft-core/exec";
import { readDraftConfig, writeDraftConfig, type UpdateCheckEntry } from "draft-core/config";
import { CLI_VERSION } from "../version.ts";
import { EXIT_OPERATIONAL_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, errorPayload, printJsonLine } from "../utils/json-output.ts";
import { dim, green, red, yellow } from "../utils/output.ts";

const GITHUB_REPO = "idodekerobo/draft";
const RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases/latest`;

// A known-stale result is rechecked less often — no point re-nagging every command.
const UP_TO_DATE_TTL_MIN = 60;
const STALE_TTL_MIN = 720;

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}
interface ReleaseInfo {
  tag_name: string;
  assets: ReleaseAsset[];
}

/** `stable-<os>-<arch>-draft-cli` — the `-cli` suffix distinguishes it from the desktop app's `.dmg` in the same release. */
function platformAssetName(): string | null {
  const os = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!os || !arch) return null;
  return `stable-${os}-${arch}-draft-cli`;
}

/** Returns 1 if a > b, -1 if a < b, 0 if equal. Non-numeric segments sort as 0. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchLatestRelease(): Promise<{ ok: true; release: ReleaseInfo } | { ok: false; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(RELEASE_API, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { ok: false, message: `GitHub API returned ${res.status}` };
    const release = (await res.json()) as ReleaseInfo;
    if (!release.tag_name) return { ok: false, message: "release response missing tag_name" };
    return { ok: true, release };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `could not reach GitHub (${message})` };
  } finally {
    clearTimeout(timer);
  }
}

function writeCheckResult(entry: UpdateCheckEntry): void {
  const result = readDraftConfig();
  const current = result.ok ? result.config : { version: "1", tools: {} };
  current.last_cli_update_check = entry;
  writeDraftConfig(current);
}

/** Synchronous cache read for index.ts's post-command notice — never fetches itself. */
export function getCachedUpdateNotice(): string | null {
  const result = readDraftConfig();
  if (!result.ok) return null;
  const entry = result.config.last_cli_update_check;
  if (!entry || entry.status !== "UPGRADE_AVAILABLE") return null;
  return `${yellow("Update available:")} draft v${entry.installed_version} → v${entry.latest_version} — run ${dim("draft update")}`;
}

/** Spawns a detached `draft update --check` if the TTL expired, so checks never add latency. */
export function checkForUpdateBackground(): void {
  if (CLI_VERSION === "0.0.0-dev") return; // source dev run — nothing to check
  const result = readDraftConfig();
  const entry = result.ok ? result.config.last_cli_update_check : undefined;
  if (entry) {
    const elapsedMin = (Date.now() - Date.parse(entry.checked_at)) / 60_000;
    const ttl = entry.status === "UP_TO_DATE" ? UP_TO_DATE_TTL_MIN : STALE_TTL_MIN;
    if (elapsedMin < ttl) return;
  }
  try {
    const proc = Bun.spawn([process.execPath, "update", "--check", "--silent"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref();
  } catch { /* best-effort only */ }
}

export async function runUpdate(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const checkOnly = args.includes("--check");
  const silent = args.includes("--silent"); // used by the background spawn — no stdout at all
  const unknown = args.find((a) => a !== "--json" && a !== "--check" && a !== "--silent");
  if (unknown) {
    if (json) printJsonLine(errorPayload("invalid_usage", `unexpected argument: ${unknown}`));
    else console.error(red(`draft update: unexpected argument: ${unknown}`));
    return EXIT_USAGE_ERROR;
  }

  if (CLI_VERSION === "0.0.0-dev") {
    const message = "draft update only applies to a compiled release binary, not `bun run src/index.ts`.";
    if (json) printJsonLine(errorPayload("dev_build", message));
    else if (!silent) console.error(red(`draft update: ${message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  const assetName = platformAssetName();
  if (!assetName) {
    const message = `no auto-update binary for ${process.platform}/${process.arch}. Reinstall manually from ${RELEASES_URL}`;
    if (json) printJsonLine(errorPayload("unsupported_platform", message));
    else if (!silent) console.error(red(`draft update: ${message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  const fetched = await fetchLatestRelease();
  if (!fetched.ok) {
    if (json) printJsonLine(errorPayload("fetch_failed", fetched.message));
    else if (!silent) console.error(red(`draft update: ${fetched.message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  const latestVersion = fetched.release.tag_name.replace(/^v/, "");
  const checkedAt = new Date().toISOString();
  const upToDate = compareVersions(CLI_VERSION, latestVersion) >= 0;

  if (upToDate) {
    writeCheckResult({ status: "UP_TO_DATE", installed_version: CLI_VERSION, latest_version: latestVersion, checked_at: checkedAt });
    if (json) printJsonLine({ status: "up_to_date", version: CLI_VERSION });
    else if (!silent) console.log(`${green("Already up to date")} (v${CLI_VERSION}).`);
    return EXIT_SUCCESS;
  }

  writeCheckResult({ status: "UPGRADE_AVAILABLE", installed_version: CLI_VERSION, latest_version: latestVersion, checked_at: checkedAt });

  if (checkOnly) {
    if (json) printJsonLine({ status: "upgrade_available", installed_version: CLI_VERSION, latest_version: latestVersion });
    else if (!silent) console.log(`Update available: v${CLI_VERSION} → v${latestVersion}. Run \`draft update\` to install.`);
    return EXIT_SUCCESS;
  }

  const asset = fetched.release.assets.find((a) => a.name === assetName);
  if (!asset) {
    const message = `release v${latestVersion} has no asset named "${assetName}"`;
    if (json) printJsonLine(errorPayload("asset_missing", message));
    else if (!silent) console.error(red(`draft update: ${message}`));
    return EXIT_OPERATIONAL_ERROR;
  }

  // Same-directory temp file so the rename() below is same-filesystem
  // (atomic) and safe even while this binary is currently executing.
  const target = realpathSync(process.execPath);
  const tmpDir = mkdtempSync(join(dirname(target), ".draft-update-"));
  const tmpPath = join(tmpDir, "draft");

  try {
    const res = await fetch(asset.browser_download_url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    await Bun.write(tmpPath, res);
    chmodSync(tmpPath, 0o755);

    const verify = await capture([tmpPath, "--version"], { timeoutMs: 5_000 });
    if (verify.exitCode !== 0 || !verify.stdout.includes(latestVersion)) {
      throw new Error(`downloaded binary failed verification (exit ${verify.exitCode}: ${verify.stdout || verify.stderr})`);
    }

    renameSync(tmpPath, target);
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    const message = err instanceof Error ? err.message : String(err);
    if (json) printJsonLine(errorPayload("update_failed", message));
    else if (!silent) console.error(red(`draft update: ${message}`));
    return EXIT_OPERATIONAL_ERROR;
  }
  rmSync(tmpDir, { recursive: true, force: true });

  writeCheckResult({ status: "UP_TO_DATE", installed_version: latestVersion, latest_version: latestVersion, checked_at: new Date().toISOString() });
  const config = readDraftConfig();
  writeDraftConfig({ ...(config.ok ? config.config : { version: "1", tools: {} }), cli_version: latestVersion });

  if (json) printJsonLine({ status: "updated", from: CLI_VERSION, to: latestVersion });
  else if (!silent) console.log(`${green("Updated")} draft v${CLI_VERSION} → v${latestVersion}.`);
  return EXIT_SUCCESS;
}

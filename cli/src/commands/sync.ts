// commands/sync.ts — canonical draft publish + draft load lifecycle

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { capture } from "../utils/exec";
import {
  getActiveProfile,
  getWorkspacePath,
  readCollaboration,
  readLocalConfig,
  writeLocalConfig,
} from "../utils/config";
import { green, red, yellow, dim, bold } from "../utils/output";
import {
  installProfileAssets,
  uninstallProfileAssets,
  validateProfileAssets,
  type ProfileAssetResult,
} from "draft-core/sync/team-assets";
import {
  openHistoryDb,
  insertFileVersion,
} from "draft-core/db/history";
import {
  publishTeamContext,
  listUnpublishedContextPaths,
  cloneTeamRepo,
  mirrorDirectory,
  mirrorFile,
  walkMarkdownFiles,
  hashAssets,
  equalHashes,
  assetsAreNonEmpty,
  assetState,
  writeAssetState,
  PublishError,
  type AssetHashes,
} from "draft-core/sync/publish";

interface SyncJsonResult {
  ok: boolean;
  profile: string;
  partial?: boolean;
  skipped?: boolean;
  reason?: string;
  installed?: { skills: string[]; mcps: string[] };
  removed?: { skills: string[]; mcps: string[] };
  missing_secrets?: Array<{ name: string; required_secrets: string[] }>;
  conflicts?: ProfileAssetResult["conflicts"];
  errors: string[];
}

function fail(message: string, json: boolean, code = 1): void {
  if (json) console.log(JSON.stringify({ ok: false, errors: [message] }));
  else console.error(red(message));
  process.exitCode = code;
}

function countJsonl(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).length;
}

function writeNotification(workspace: string, name: string, message: string): void {
  const path = join(workspace, "notifications", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, message.trimEnd() + "\n", "utf8");
}

function formatAssets(result: ProfileAssetResult): SyncJsonResult {
  return {
    ok: true,
    profile: result.profile,
    partial: result.conflicts.length > 0 || result.missingSecrets.length > 0 || result.errors.length > 0,
    installed: { skills: result.installedSkills, mcps: result.installedMcps },
    removed: { skills: result.removedSkills, mcps: result.removedMcps },
    missing_secrets: result.missingSecrets.map(({ name, requiredSecrets }) => ({
      name, required_secrets: requiredSecrets,
    })),
    conflicts: result.conflicts,
    errors: result.errors,
  };
}

function collectRepeatedFlag(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] !== undefined) out.push(args[++i]);
  }
  return out;
}

// ── publish ───────────────────────────────────────────────────────────────────

export async function runPublish(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);

  if (args.includes("--list-changed")) {
    const paths = listUnpublishedContextPaths(workspace);
    if (json) console.log(JSON.stringify({ ok: true, profile, paths }));
    else if (paths.length) console.log(paths.join("\n"));
    else console.log(dim("Nothing to publish."));
    return;
  }

  const paths = collectRepeatedFlag(args, "--path");

  const validation = validateProfileAssets(profile);
  if (!validation.ok) {
    fail(`Team assets are invalid: ${validation.errors.map((entry) => entry.message).join("; ")}`, json, 2);
    return;
  }
  const gh = await capture(["gh", "api", "user", "--jq", ".login"]);
  if (gh.exitCode !== 0 || !gh.stdout.trim()) {
    fail("GitHub CLI not authenticated. Run `gh auth login` first.", json, 3);
    return;
  }

  try {
    const result = await publishTeamContext(workspace, profile, paths.length ? { paths } : undefined);
    if (json) {
      console.log(JSON.stringify({ ok: true, profile, ...result, errors: [] }));
    } else if (!result.published) {
      console.log(dim("Nothing to publish."));
    } else {
      console.log(`${green("✓")} Published ${result.scoped ? `${bold(String(result.files.length))} file(s)` : "team context and assets"}${result.proposalsCleared ? ` with ${bold(String(result.proposalsCleared))} proposal(s)` : ""}.`);
    }
  } catch (error) {
    fail(error instanceof PublishError || error instanceof Error ? error.message : String(error), json, 3);
  }
}

// ── load ──────────────────────────────────────────────────────────────────────

export async function runLoad(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const sessionStart = args.includes("--session-start");
  const discard = args.includes("--discard-team-assets");
  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);

  const finishFailure = (message: string, code = 1) => {
    if (sessionStart) {
      writeNotification(workspace, "load-team-warning.txt", `Team load skipped: ${message}`);
      if (json) console.log(JSON.stringify({ ok: true, profile, skipped: true, reason: message, errors: [] }));
      return;
    }
    fail(message, json, code);
  };

  if (sessionStart && discard) {
    finishFailure("--discard-team-assets is unavailable during SessionStart.");
    return;
  }

  const localValidation = validateProfileAssets(profile);
  if (!localValidation.ok) {
    finishFailure(`local team assets are invalid: ${localValidation.errors.map((entry) => entry.message).join("; ")}`);
    return;
  }
  const currentHashes = hashAssets(workspace);
  const baseline = assetState(workspace).baseline;
  if (!discard && ((!baseline && assetsAreNonEmpty(workspace)) || (baseline && !equalHashes(currentHashes, baseline)))) {
    finishFailure("unpublished team asset changes detected. Run `draft publish` or explicitly rerun `draft load --discard-team-assets`.");
    return;
  }
  if (!discard && listUnpublishedContextPaths(workspace).length > 0) {
    finishFailure("unpublished local context changes detected. Run `draft publish` before loading.");
    return;
  }

  const cloned = await cloneTeamRepo(workspace);
  if ("error" in cloned) {
    finishFailure(cloned.error, 2);
    return;
  }

  const validation = validateProfileAssets(profile, { workspacePath: cloned.root });
  if (!validation.ok) {
    rmSync(cloned.tmp, { recursive: true, force: true });
    finishFailure(`remote team assets are invalid: ${validation.errors.map((entry) => entry.message).join("; ")}`);
    return;
  }

  const backup = mkdtempSync(join(tmpdir(), "draft-load-backup-"));
  try {
    for (const item of ["context", "skills", "CHANGES.jsonl"]) {
      const source = join(workspace, item);
      if (existsSync(source)) {
        if (lstatSync(source).isDirectory()) cpSync(source, join(backup, item), { recursive: true });
        else cpSync(source, join(backup, item));
      }
    }
    for (const name of ["mcp.json", "collaboration.json"]) {
      const source = join(workspace, "config", name);
      if (existsSync(source)) {
        mkdirSync(join(backup, "config"), { recursive: true });
        cpSync(source, join(backup, "config", name));
      }
    }

    await uninstallProfileAssets(profile);
    mirrorDirectory(join(cloned.root, "context"), join(workspace, "context"));
    mirrorDirectory(join(cloned.root, "skills"), join(workspace, "skills"));
    mirrorFile(join(cloned.root, "config", "mcp.json"), join(workspace, "config", "mcp.json"));
    mirrorFile(join(cloned.root, "config", "collaboration.json"), join(workspace, "config", "collaboration.json"));
    mirrorFile(join(cloned.root, "CHANGES.jsonl"), join(workspace, "CHANGES.jsonl"));

    const loadedAt = new Date().toISOString();
    const newContextRoot = join(workspace, "context");
    const backupContextRoot = join(backup, "context");
    const historyDb = openHistoryDb(workspace);
    try {
      const relPaths = new Set([
        ...walkMarkdownFiles(newContextRoot),
        ...walkMarkdownFiles(backupContextRoot),
      ]);
      for (const relPath of relPaths) {
        const newPath = join(newContextRoot, relPath);
        const oldPath = join(backupContextRoot, relPath);
        const newContent = existsSync(newPath) ? readFileSync(newPath, "utf8") : null;
        const oldContent = existsSync(oldPath) ? readFileSync(oldPath, "utf8") : null;
        if (newContent !== null && newContent !== oldContent) {
          // Content just came from the remote repo, so it IS the current
          // published state — mark it published at load time. Otherwise every
          // freshly-loaded file looks "unpublished" (diffs against "", and
          // trips the load-time "unpublished changes" guard) until the user
          // edits and republishes it.
          insertFileVersion(historyDb, {
            filePath: relPath,
            content: newContent,
            createdAt: loadedAt,
            source: "team-load",
            author: null,
            sessionId: null,
            publishedAt: loadedAt,
            changesEntryId: null,
          });
        }
      }
    } finally {
      historyDb.close();
    }

    const result = await installProfileAssets(profile);
    const hashes = hashAssets(workspace);
    writeAssetState(workspace, hashes, "load");
    writeLocalConfig(workspace, {
      last_loaded: new Date().toISOString(),
      lastLoadCursor: countJsonl(join(workspace, "CHANGES.jsonl")),
    });

    const output = formatAssets(result);
    if (sessionStart) {
      const note = output.partial
        ? `Team context loaded with required actions: ${result.missingSecrets.length} MCP credential set(s) missing; ${result.conflicts.length} personal-name conflict(s).`
        : "Team context and assets refreshed from the shared repository.";
      writeNotification(workspace, output.partial ? "load-team-warning.txt" : "load-team-loaded.txt", note);
    }
    if (json) console.log(JSON.stringify(output));
    else {
      console.log(`${green("✓")} Team context and assets loaded.`);
      if (result.missingSecrets.length) console.log(`${yellow("⚠")} MCP credentials required: ${result.missingSecrets.map((entry) => entry.name).join(", ")}`);
      if (result.conflicts.length) console.log(`${yellow("⚠")} Personal assets preserved for ${result.conflicts.length} conflict(s).`);
    }
  } catch (error) {
    try {
      await uninstallProfileAssets(profile);
      mirrorDirectory(join(backup, "context"), join(workspace, "context"));
      mirrorDirectory(join(backup, "skills"), join(workspace, "skills"));
      mirrorFile(join(backup, "config", "mcp.json"), join(workspace, "config", "mcp.json"));
      mirrorFile(join(backup, "config", "collaboration.json"), join(workspace, "config", "collaboration.json"));
      mirrorFile(join(backup, "CHANGES.jsonl"), join(workspace, "CHANGES.jsonl"));
      await installProfileAssets(profile);
    } catch {
      // Preserve the original failure; the lifecycle error is reported below.
    }
    finishFailure(error instanceof Error ? error.message : String(error), 3);
  } finally {
    rmSync(backup, { recursive: true, force: true });
    rmSync(cloned.tmp, { recursive: true, force: true });
  }
}

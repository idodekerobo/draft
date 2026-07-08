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
  unlinkSync,
  writeFileSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { tmpdir } from "os";
import { dirname, join, relative } from "path";
import { capture } from "../utils/exec";
import {
  getActiveProfile,
  getWorkspacePath,
  readCollaboration,
  readLocalConfig,
  writeLocalConfig,
} from "../utils/config";
import { green, red, yellow, dim, cyan, bold } from "../utils/output";
import {
  installProfileAssets,
  uninstallProfileAssets,
  validateProfileAssets,
  type ProfileAssetResult,
} from "draft-core/sync/team-assets";
import {
  openHistoryDb,
  insertFileVersion,
  getLatestUnpublishedVersion,
  markPublished,
} from "draft-core/db/history";

interface AssetHashes {
  skills_hash: string;
  mcp_hash: string;
}

interface TeamAssetLocalState {
  baseline?: AssetHashes;
  last_remote?: AssetHashes;
}

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

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function hashSkills(workspace: string): string {
  const root = join(workspace, "skills");
  const hash = createHash("sha256");
  if (!existsSync(root)) return `sha256:${hash.update("").digest("hex")}`;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".DS_Store" || entry.name.startsWith(".draft-")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(root);
  for (const path of files) {
    hash.update(relative(root, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function hashMcp(workspace: string): string {
  const path = join(workspace, "config", "mcp.json");
  const value = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : { version: 1, servers: [] };
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function hashAssets(workspace: string): AssetHashes {
  return { skills_hash: hashSkills(workspace), mcp_hash: hashMcp(workspace) };
}

function equalHashes(a?: AssetHashes, b?: AssetHashes): boolean {
  return !!a && !!b && a.skills_hash === b.skills_hash && a.mcp_hash === b.mcp_hash;
}

function assetsAreNonEmpty(workspace: string): boolean {
  const skills = join(workspace, "skills");
  if (existsSync(skills) && readdirSync(skills).some((name) => !name.startsWith("."))) return true;
  const mcp = join(workspace, "config", "mcp.json");
  if (!existsSync(mcp)) return false;
  try {
    return (JSON.parse(readFileSync(mcp, "utf8")).servers ?? []).length > 0;
  } catch {
    return true;
  }
}

function assetState(workspace: string): TeamAssetLocalState {
  const local = readLocalConfig(workspace);
  if (!local.ok) return {};
  return ((local.config as typeof local.config & { team_assets?: TeamAssetLocalState }).team_assets ?? {});
}

function writeAssetState(workspace: string, hashes: AssetHashes, kind: "load" | "publish"): void {
  const current = readLocalConfig(workspace);
  const prior = current.ok
    ? ((current.config as typeof current.config & { team_assets?: TeamAssetLocalState }).team_assets ?? {})
    : {};
  writeLocalConfig(workspace, {
    team_assets: {
      ...prior,
      baseline: hashes,
      ...(kind === "load" ? { last_remote: hashes } : {}),
    },
  });
}

function mirrorDirectory(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function mirrorFile(source: string, destination: string): void {
  rmSync(destination, { force: true });
  if (!existsSync(source)) return;
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}

function copyPublishedState(workspace: string, repoRoot: string): void {
  mirrorDirectory(join(workspace, "context"), join(repoRoot, "context"));
  mirrorDirectory(join(workspace, "skills"), join(repoRoot, "skills"));
  mirrorFile(join(workspace, "config", "mcp.json"), join(repoRoot, "config", "mcp.json"));
  mirrorFile(join(workspace, "config", "collaboration.json"), join(repoRoot, "config", "collaboration.json"));
}

function walkMarkdownFiles(root: string): string[] {
  const results: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) results.push(relative(root, path));
    }
  };
  walk(root);
  return results;
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

function hasUnpublishedContext(workspace: string): boolean {
  const accepted = join(workspace, "accepted");
  if (existsSync(accepted) && readdirSync(accepted).some((name) => name.endsWith(".md"))) return true;
  const local = readLocalConfig(workspace);
  const lastPublished = local.ok ? local.config.last_published : undefined;
  const context = join(workspace, "context");
  if (!existsSync(context)) return false;
  const cutoff = lastPublished ? Date.parse(lastPublished) : 0;
  for (const dimension of readdirSync(context, { withFileTypes: true })) {
    if (!dimension.isDirectory()) continue;
    const log = join(context, dimension.name, "log");
    if (!existsSync(log)) continue;
    for (const entry of readdirSync(log)) {
      const path = join(log, entry);
      if (lstatSync(path).isFile() && (!lastPublished || statSync(path).mtimeMs > cutoff)) return true;
    }
  }
  return false;
}

async function cloneTeamRepo(workspace: string): Promise<{ tmp: string; root: string } | { error: string }> {
  const collab = readCollaboration(workspace);
  if (!collab.ok || collab.collab.mode !== "github" || !collab.collab.team_repo_url) {
    return { error: "No team repo configured. Run /draft:setup-collab first." };
  }
  const tmp = mkdtempSync(join(tmpdir(), "draft-team-"));
  const cloned = await capture(["git", "clone", "--depth", "1", collab.collab.team_repo_url, tmp], { timeoutMs: 60_000 });
  if (cloned.exitCode !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    return { error: cloned.stderr.trim() || cloned.stdout.trim() || "Failed to clone team repository." };
  }
  const root = collab.collab.team_repo_subdir && collab.collab.team_repo_subdir !== "root"
    ? join(tmp, collab.collab.team_repo_subdir)
    : tmp;
  return { tmp, root };
}

// ── publish ───────────────────────────────────────────────────────────────────

export async function runPublish(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);
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

  const cloned = await cloneTeamRepo(workspace);
  if ("error" in cloned) {
    fail(cloned.error, json, 2);
    return;
  }

  try {
    mkdirSync(cloned.root, { recursive: true });
    copyPublishedState(workspace, cloned.root);

    const changesPath = join(cloned.root, "CHANGES.jsonl");
    const change = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      type: "team-publish",
      author: gh.stdout.trim(),
      profile,
      files: ["context/", "skills/", "config/mcp.json"],
    };
    writeFileSync(changesPath, (existsSync(changesPath) ? readFileSync(changesPath, "utf8").trimEnd() + "\n" : "") + JSON.stringify(change) + "\n");

    const add = await capture(["git", "-C", cloned.tmp, "add", "-A"]);
    if (add.exitCode !== 0) throw new Error(add.stderr || "git add failed");
    const status = await capture(["git", "-C", cloned.tmp, "status", "--porcelain"]);
    if (status.exitCode !== 0) throw new Error(status.stderr || "git status failed");
    if (!status.stdout.trim()) {
      if (json) console.log(JSON.stringify({ ok: true, profile, published: false, errors: [] }));
      else console.log(dim("Nothing to publish."));
      return;
    }

    const commit = await capture(["git", "-C", cloned.tmp, "commit", "-m", `draft publish: ${profile}`]);
    if (commit.exitCode !== 0) throw new Error(commit.stderr || commit.stdout || "git commit failed");
    const push = await capture(["git", "-C", cloned.tmp, "push"], { timeoutMs: 60_000 });
    if (push.exitCode !== 0) throw new Error(push.stderr || push.stdout || "git push failed");

    const historyDb = openHistoryDb(workspace);
    try {
      for (const relPath of walkMarkdownFiles(join(workspace, "context"))) {
        const version = getLatestUnpublishedVersion(historyDb, relPath);
        if (version && !version.publishedAt) {
          markPublished(historyDb, version.id, change.ts, change.id);
        }
      }
    } finally {
      historyDb.close();
    }

    const accepted = join(workspace, "accepted");
    let proposals = 0;
    if (existsSync(accepted)) {
      for (const name of readdirSync(accepted).filter((entry) => entry.endsWith(".md"))) {
        unlinkSync(join(accepted, name));
        proposals++;
      }
    }
    const now = new Date().toISOString();
    writeLocalConfig(workspace, { last_published: now });
    writeAssetState(workspace, hashAssets(workspace), "publish");

    if (json) {
      console.log(JSON.stringify({ ok: true, profile, published: true, proposals, errors: [] }));
    } else {
      console.log(`${green("✓")} Published team context and assets${proposals ? ` with ${bold(String(proposals))} proposal(s)` : ""}.`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), json, 3);
  } finally {
    rmSync(cloned.tmp, { recursive: true, force: true });
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
  if (!discard && hasUnpublishedContext(workspace)) {
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
          insertFileVersion(historyDb, {
            filePath: relPath,
            content: newContent,
            createdAt: loadedAt,
            source: "team-load",
            author: null,
            sessionId: null,
            publishedAt: null,
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

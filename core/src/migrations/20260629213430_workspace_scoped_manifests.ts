import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

type V4SkillEntry = {
  id: string;
  name: string;
  source?: "user" | "team";
  profile?: string;
  [key: string]: unknown;
};

type V4McpEntry = {
  id: string;
  name: string;
  source?: "user" | "team";
  profile?: string;
  [key: string]: unknown;
};

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function assertSafeProfile(profile: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) {
    throw new Error(`Cannot migrate manifest entry with invalid profile: ${profile}`);
  }
}

function readExistingV5(
  targetPath: string,
  collection: "skills" | "mcps",
): Record<string, unknown> {
  if (!existsSync(targetPath)) return {};
  const parsed = readJson(targetPath);
  if (parsed.schema_version !== 5 || typeof parsed[collection] !== "object" || parsed[collection] === null) {
    throw new Error(`Cannot merge migration into non-v5 manifest: ${targetPath}`);
  }
  return parsed;
}

export async function migrateWorkspaceScopedManifests(home = homedir()): Promise<void> {
  const stateDir = join(home, ".draft", "state");
  const workspacesDir = join(home, ".draft", "workspaces");

  const skillGlobal = join(stateDir, "skill-manifest.json");
  const mcpGlobal = join(stateDir, "mcp-manifest.json");
  const skillBackup = join(stateDir, "skill-manifest-v4-backup.json");
  const mcpBackup = join(stateDir, "mcp-manifest-v4-backup.json");

  // ── Skill manifest migration ──────────────────────────────────────────────────

  if (existsSync(skillGlobal) && !existsSync(skillBackup)) {
    const parsed = readJson(skillGlobal);

    if (parsed.schema_version === 4) {
      const skills = (parsed.skills ?? {}) as Record<string, V4SkillEntry>;
      const byProfile: Record<string, Record<string, unknown>> = { default: {} };

      for (const [oldId, entry] of Object.entries(skills)) {
        const isTeam = entry.source === "team" && Boolean(entry.profile);
        const targetProfile = isTeam ? entry.profile! : "default";
        assertSafeProfile(targetProfile);
        const newId = isTeam ? `team:${entry.name}` : oldId;
        const newKind = isTeam ? "team" : "personal";

        if (!byProfile[targetProfile]) byProfile[targetProfile] = {};
        const { source: _source, profile: _profile, ...rest } = entry;
        byProfile[targetProfile][newId] = { ...rest, id: newId, kind: newKind };
      }

      for (const [profile, profileSkills] of Object.entries(byProfile)) {
        const targetPath = join(workspacesDir, profile, "config", "skill-manifest.json");
        const existing = readExistingV5(targetPath, "skills");
        writeJsonAtomic(targetPath, {
          version: 5,
          schema_version: 5,
          min_reader_version: 1,
          ...existing,
          skills: {
            ...profileSkills,
            ...((existing.skills ?? {}) as Record<string, unknown>),
          },
          name_conflicts: {
            ...(profile === "default"
              ? (parsed.name_conflicts ?? {}) as Record<string, unknown>
              : {}),
            ...((existing.name_conflicts ?? {}) as Record<string, unknown>),
          },
        });
      }

      renameSync(skillGlobal, skillBackup);
    }
  }

  // ── MCP manifest migration ────────────────────────────────────────────────────

  if (existsSync(mcpGlobal) && !existsSync(mcpBackup)) {
    const parsed = readJson(mcpGlobal);

    if (parsed.schema_version === 4) {
      const mcps = (parsed.mcps ?? {}) as Record<string, V4McpEntry>;
      const byProfile: Record<string, Record<string, unknown>> = { default: {} };

      for (const [oldId, entry] of Object.entries(mcps)) {
        const isTeam = Boolean(entry.profile);
        const targetProfile = isTeam ? entry.profile! : "default";
        assertSafeProfile(targetProfile);
        const newId = isTeam ? `team:${entry.name}` : oldId;
        const newKind = isTeam ? "team" : "personal";

        if (!byProfile[targetProfile]) byProfile[targetProfile] = {};
        const { source: _source, profile: _profile, ...rest } = entry;
        byProfile[targetProfile][newId] = { ...rest, id: newId, kind: newKind };
      }

      for (const [profile, profileMcps] of Object.entries(byProfile)) {
        const targetPath = join(workspacesDir, profile, "config", "mcp-manifest.json");
        const existing = readExistingV5(targetPath, "mcps");
        writeJsonAtomic(targetPath, {
          version: 5,
          schema_version: 5,
          ...existing,
          mcps: {
            ...profileMcps,
            ...((existing.mcps ?? {}) as Record<string, unknown>),
          },
          name_conflicts: {
            ...(profile === "default"
              ? (parsed.name_conflicts ?? {}) as Record<string, unknown>
              : {}),
            ...((existing.name_conflicts ?? {}) as Record<string, unknown>),
          },
        });
      }

      renameSync(mcpGlobal, mcpBackup);
    }
  }
}

export default migrateWorkspaceScopedManifests;

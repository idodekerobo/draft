// core/src/agents/mcp.ts — unified read/write/remove of MCP config for all supported agents
//
// Dispatches by agent type: Claude Code uses ~/.claude.json (JSON),
// Codex uses ~/.codex/config.toml (TOML surgical splice).

import { readFileSync, existsSync, statSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { parse as parseToml } from "smol-toml";
import { atomicPatch, ParseError } from "../sync/atomic-write";
import type { Agent } from "../sync/manifest";

const DEFAULT_CLAUDE_JSON_PATH = join(homedir(), ".claude.json");
const DEFAULT_CODEX_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

// ── Path helpers ───────────────────────────────────────────────────────────────

function defaultConfigPath(agent: Agent): string {
  return agent === "claude-code" ? DEFAULT_CLAUDE_JSON_PATH : DEFAULT_CODEX_CONFIG_PATH;
}

// ── Read ───────────────────────────────────────────────────────────────────────

/**
 * Read all MCP entries from an agent's config file.
 * Returns an object keyed by MCP name.
 * Throws ParseError if the file is malformed.
 */
export function readAgentMcps(
  agent: Agent,
  configPath?: string,
): Record<string, Record<string, unknown>> {
  const path = configPath ?? defaultConfigPath(agent);
  if (!existsSync(path)) return {};

  const raw = readFileSync(path, "utf8");

  if (agent === "claude-code") {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(raw); } catch (e) { throw new ParseError(path, e); }
    if (!parsed || typeof parsed !== "object") return {};

    // Collect project-scoped MCPs first (lower priority)
    const merged: Record<string, Record<string, unknown>> = {};
    const projects = parsed["projects"] as Record<string, { mcpServers?: Record<string, Record<string, unknown>> }> | undefined;
    if (projects && typeof projects === "object") {
      for (const proj of Object.values(projects)) {
        if (proj?.mcpServers && typeof proj.mcpServers === "object") {
          for (const [name, entry] of Object.entries(proj.mcpServers)) {
            if (!(name in merged)) merged[name] = entry;
          }
        }
      }
    }

    // User-scope overwrites project-scope on conflict
    const userScope = (parsed["mcpServers"] as Record<string, Record<string, unknown>>) ?? {};
    return { ...merged, ...userScope };
  }

  // Codex: TOML
  let parsed: Record<string, unknown>;
  try { parsed = parseToml(raw) as Record<string, unknown>; } catch (e) { throw new ParseError(path, e); }
  const servers = parsed["mcp_servers"];
  if (!servers || typeof servers !== "object") return {};
  return servers as Record<string, Record<string, unknown>>;
}

// ── Write ──────────────────────────────────────────────────────────────────────

/**
 * Write or update a single MCP entry in an agent's config file.
 * `entry` is the agent-native config object (already serialized to the agent's format).
 */
export async function writeAgentMcp(
  agent: Agent,
  name: string,
  entry: object,
  configPath?: string,
): Promise<void> {
  const path = configPath ?? defaultConfigPath(agent);

  if (agent === "claude-code") {
    ensureClaudeJsonPermissions(path);
    await atomicPatch(
      path,
      (rawText) => {
        let parsed: Record<string, unknown>;
        try { parsed = rawText.trim() ? JSON.parse(rawText) : {}; } catch (e) { throw new ParseError(path, e); }
        if (!parsed || typeof parsed !== "object") parsed = {};
        const existing = (parsed["mcpServers"] as Record<string, unknown>) ?? {};
        parsed["mcpServers"] = { ...existing, [name]: entry };
        return JSON.stringify(parsed, null, 2) + "\n";
      },
      { mode: 0o600 },
    );
    return;
  }

  // Codex: surgical TOML splice
  const toml = generateCodexMcpToml(name, entry as Record<string, unknown>);
  await atomicPatch(path, (rawText) => spliceMcpSection(rawText, name, toml));
}

// ── Remove ─────────────────────────────────────────────────────────────────────

/**
 * Remove a single MCP entry from an agent's config file.
 * Preserves all other content.
 */
export async function removeAgentMcp(
  agent: Agent,
  name: string,
  configPath?: string,
): Promise<void> {
  const path = configPath ?? defaultConfigPath(agent);

  if (agent === "claude-code") {
    await atomicPatch(path, (rawText) => {
      let parsed: Record<string, unknown>;
      try { parsed = rawText.trim() ? JSON.parse(rawText) : {}; } catch (e) { throw new ParseError(path, e); }
      if (!parsed || typeof parsed !== "object") return rawText;
      const servers = { ...(parsed["mcpServers"] as Record<string, unknown> ?? {}) };
      delete servers[name];
      parsed["mcpServers"] = servers;
      return JSON.stringify(parsed, null, 2) + "\n";
    });
    return;
  }

  // Codex: remove only the [mcp_servers."name"] section
  await atomicPatch(path, (rawText) => {
    const qName = escapeTomlKey(name);
    const pattern = new RegExp(
      `\\[mcp_servers\\.${escapeRegex(qName)}\\][^\\[]*`,
      "ms",
    );
    return rawText.replace(pattern, "").replace(/\n{3,}/g, "\n\n");
  });
}

// ── Codex TOML helpers (private) ───────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeTomlKey(name: string): string {
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function spliceMcpSection(rawText: string, name: string, newToml: string): string {
  const qName = escapeTomlKey(name);
  const pattern = new RegExp(
    `(\\[mcp_servers\\.${escapeRegex(qName)}\\][^\\[]*)`,
    "ms",
  );
  const trimmed = newToml.trimEnd() + "\n\n";
  if (pattern.test(rawText)) {
    return rawText.replace(pattern, trimmed);
  }
  return rawText.trimEnd() + "\n\n" + trimmed;
}

function generateCodexMcpToml(name: string, entry: Record<string, unknown>): string {
  const qName = escapeTomlKey(name);
  const lines: string[] = [`[mcp_servers.${qName}]`];
  const subTables: Array<{ key: string; obj: Record<string, unknown> }> = [];

  for (const [k, v] of Object.entries(entry)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      subTables.push({ key: k, obj: v as Record<string, unknown> });
    } else if (typeof v === "string") {
      lines.push(`${k} = ${JSON.stringify(v)}`);
    } else if (typeof v === "boolean") {
      lines.push(`${k} = ${v}`);
    } else if (typeof v === "number") {
      lines.push(`${k} = ${v}`);
    } else if (Array.isArray(v)) {
      lines.push(`${k} = [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
    }
  }

  for (const { key, obj } of subTables) {
    lines.push(`[mcp_servers.${qName}.${key}]`);
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      if (typeof v === "string") lines.push(`${k} = ${JSON.stringify(v)}`);
      else if (typeof v === "boolean") lines.push(`${k} = ${v}`);
      else if (typeof v === "number") lines.push(`${k} = ${v}`);
    }
  }

  return lines.join("\n") + "\n";
}

// ── Claude Code permission helper (private) ────────────────────────────────────

function ensureClaudeJsonPermissions(path: string): void {
  try {
    const stat = statSync(path);
    if ((stat.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
  } catch { /* file may not exist yet */ }
}

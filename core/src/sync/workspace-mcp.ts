// core/src/sync/workspace-mcp.ts — workspace-level MCP manifest (shared via git)
//
// ~/.draft/workspaces/<profile>/config/mcp.json is the team-shared MCP list.
// It stores CanonicalMcp entries with value_env refs only — never literal secrets.
// Teammates supply the actual secret values locally via secrets.json / settings.

import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from "fs";
import { join, dirname } from "path";
import type { CanonicalMcp } from "./manifest";

export interface WorkspaceMcpEntry {
  name: string;
  /** Canonical form with value_env refs only — no literal secret values. */
  canonical: CanonicalMcp;
  /** Env var names the teammate must supply (e.g. DRAFT_MCP_LINEAR_TOKEN). */
  required_secrets: string[];
  description?: string;
}

export interface WorkspaceMcpManifest {
  version: 1;
  servers: WorkspaceMcpEntry[];
}

export interface WorkspaceMcpValidationIssue {
  path: string;
  message: string;
}

export interface WorkspaceMcpValidation {
  ok: boolean;
  errors: WorkspaceMcpValidationIssue[];
  manifest?: WorkspaceMcpManifest;
}

export class WorkspaceMcpValidationError extends Error {
  constructor(public readonly errors: WorkspaceMcpValidationIssue[]) {
    super(errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    this.name = "WorkspaceMcpValidationError";
  }
}

export function emptyWorkspaceMcpManifest(): WorkspaceMcpManifest {
  return { version: 1, servers: [] };
}

export function validateWorkspaceMcpManifest(input: unknown): WorkspaceMcpValidation {
  const errors: WorkspaceMcpValidationIssue[] = [];
  const add = (path: string, message: string) => errors.push({ path, message });
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [{ path: "$", message: "must be an object" }] };
  }
  const root = input as Record<string, unknown>;
  if (root.version !== 1) add("$.version", "unsupported version (expected 1)");
  if (!Array.isArray(root.servers)) {
    add("$.servers", "must be an array");
    return { ok: false, errors };
  }

  const names = new Set<string>();
  root.servers.forEach((raw, index) => {
    const base = `$.servers[${index}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      add(base, "must be an object");
      return;
    }
    const server = raw as Record<string, unknown>;
    const name = server.name;
    if (typeof name !== "string" || !name.trim()) add(`${base}.name`, "must be a non-empty string");
    else if (names.has(name)) add(`${base}.name`, `duplicate server name "${name}"`);
    else names.add(name);

    const canonical = server.canonical;
    const referenced: string[] = [];
    if (!canonical || typeof canonical !== "object" || Array.isArray(canonical)) {
      add(`${base}.canonical`, "must be an object");
    } else {
      const config = canonical as Record<string, unknown>;
      if (config.type !== "http") add(`${base}.canonical.type`, "unsupported MCP type (expected http)");
      if (typeof config.url !== "string") {
        add(`${base}.canonical.url`, "must be a valid HTTP(S) URL");
      } else {
        try {
          const url = new URL(config.url);
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
        } catch {
          add(`${base}.canonical.url`, "must be a valid HTTP(S) URL");
        }
      }
      if (config.headers !== undefined) {
        if (!config.headers || typeof config.headers !== "object" || Array.isArray(config.headers)) {
          add(`${base}.canonical.headers`, "must be an object");
        } else {
          for (const [header, rawValue] of Object.entries(config.headers as Record<string, unknown>)) {
            const headerPath = `${base}.canonical.headers.${header}`;
            if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
              add(headerPath, "must be an object");
              continue;
            }
            const value = rawValue as Record<string, unknown>;
            if (value.secret === true) {
              if ("value_literal" in value) add(`${headerPath}.value_literal`, "secret headers cannot contain literal values");
              if (typeof value.value_env !== "string" || !value.value_env) {
                add(`${headerPath}.value_env`, "secret headers require a non-empty environment variable");
              } else {
                referenced.push(value.value_env);
              }
            } else if (value.secret !== false) {
              add(`${headerPath}.secret`, "must be a boolean");
            }
          }
        }
      }
    }

    if (!Array.isArray(server.required_secrets) ||
        server.required_secrets.some((value) => typeof value !== "string" || !value)) {
      add(`${base}.required_secrets`, "must be an array of non-empty strings");
    } else {
      const required = server.required_secrets as string[];
      const requiredSet = new Set(required);
      const referencedSet = new Set(referenced);
      if (requiredSet.size !== required.length) add(`${base}.required_secrets`, "contains duplicate environment variables");
      if (referencedSet.size !== referenced.length) add(`${base}.canonical`, "references a duplicate environment variable");
      for (const env of requiredSet) {
        if (!referencedSet.has(env)) add(`${base}.required_secrets`, `"${env}" is not referenced by canonical configuration`);
      }
      for (const env of referencedSet) {
        if (!requiredSet.has(env)) add(`${base}.required_secrets`, `missing referenced secret "${env}"`);
      }
    }
  });

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, errors: [], manifest: input as WorkspaceMcpManifest };
}

export function readWorkspaceMcpManifest(workspacePath: string): WorkspaceMcpManifest {
  const path = join(workspacePath, "config", "mcp.json");
  if (!existsSync(path)) return emptyWorkspaceMcpManifest();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new WorkspaceMcpValidationError([{
      path: "$",
      message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    }]);
  }
  const validation = validateWorkspaceMcpManifest(parsed);
  if (!validation.ok || !validation.manifest) throw new WorkspaceMcpValidationError(validation.errors);
  return validation.manifest;
}

export function writeWorkspaceMcpManifest(workspacePath: string, manifest: WorkspaceMcpManifest): void {
  const path = join(workspacePath, "config", "mcp.json");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

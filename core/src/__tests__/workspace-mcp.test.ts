import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  readWorkspaceMcpManifest,
  validateWorkspaceMcpManifest,
  WorkspaceMcpValidationError,
  type WorkspaceMcpManifest,
} from "../sync/workspace-mcp";

const TMP = join("/tmp", `draft-workspace-mcp-${process.pid}`);

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("workspace MCP validation", () => {
  const valid = {
    version: 1,
    servers: [{
      name: "linear",
      canonical: {
        type: "http",
        url: "https://mcp.example.com",
        headers: {
          Authorization: { value_env: "DRAFT_MCP_LINEAR_TOKEN", secret: true },
        },
      },
      required_secrets: ["DRAFT_MCP_LINEAR_TOKEN"],
    }],
  } satisfies WorkspaceMcpManifest;

  it("accepts a valid manifest", () => {
    const result = validateWorkspaceMcpManifest(valid);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest).toEqual(valid);
  });

  it("rejects unsafe and inconsistent secret declarations", () => {
    const result = validateWorkspaceMcpManifest({
      ...valid,
      servers: [{
        ...valid.servers[0],
        canonical: {
          ...valid.servers[0].canonical,
          headers: {
            Authorization: { value_literal: "token", secret: true },
          },
        },
      }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.message).join(" ")).toContain("literal");
    expect(result.errors.map((error) => error.message).join(" ")).toContain("value");
  });

  it("rejects duplicate names, invalid URLs, and unsupported types", () => {
    const result = validateWorkspaceMcpManifest({
      version: 1,
      servers: [
        { name: "same", canonical: { type: "stdio", url: "file:///tmp/x" }, required_secrets: [] },
        { name: "same", canonical: { type: "http", url: "not a url" }, required_secrets: [] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.message.includes("duplicate"))).toBe(true);
    expect(result.errors.some((error) => error.message.includes("unsupported MCP type"))).toBe(true);
    expect(result.errors.some((error) => error.message.includes("valid HTTP"))).toBe(true);
  });

  it("throws instead of silently treating malformed JSON as empty", () => {
    mkdirSync(join(TMP, "config"), { recursive: true });
    writeFileSync(join(TMP, "config", "mcp.json"), "{bad");
    expect(() => readWorkspaceMcpManifest(TMP)).toThrow(WorkspaceMcpValidationError);
  });
});

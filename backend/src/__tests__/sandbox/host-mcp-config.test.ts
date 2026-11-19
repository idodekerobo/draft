import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDraftMcpConfig } from "../../sandbox/host/mcp-config";

const RUN_ONE_URL = "https://api.draft.test/runs/11111111-1111-4111-8111-111111111111/mcp";
const RUN_TWO_URL = "https://api.draft.test/runs/22222222-2222-4222-8222-222222222222/mcp";
const DRAFT_ENTRY = (url: string) => ({ type: "http", url, headers: { Authorization: "Bearer ${DRAFT_MCP_TOKEN}" } });

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "draft-mcp-config-"));
  path = join(dir, ".claude.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8"));

describe("writeDraftMcpConfig", () => {
  it("creates a user-scope draft server when there is no config yet", () => {
    writeDraftMcpConfig(path, RUN_ONE_URL);
    expect(read()).toEqual({ mcpServers: { draft: DRAFT_ENTRY(RUN_ONE_URL) } });
  });

  it("writes the bearer header as a placeholder, so the token never reaches the file", () => {
    writeDraftMcpConfig(path, RUN_ONE_URL);
    expect(readFileSync(path, "utf8")).toContain("Bearer ${DRAFT_MCP_TOKEN}");
  });

  it("keeps the rest of an existing config and the other servers", () => {
    writeFileSync(
      path,
      JSON.stringify({
        hasCompletedOnboarding: true,
        projects: { "/data/workspace": { hasTrustDialogAccepted: true } },
        mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
      }),
    );
    writeDraftMcpConfig(path, RUN_ONE_URL);
    expect(read()).toEqual({
      hasCompletedOnboarding: true,
      projects: { "/data/workspace": { hasTrustDialogAccepted: true } },
      mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" }, draft: DRAFT_ENTRY(RUN_ONE_URL) },
    });
  });

  it("points an existing draft server at the URL of a new run", () => {
    writeDraftMcpConfig(path, RUN_ONE_URL);
    writeDraftMcpConfig(path, RUN_TWO_URL);
    expect(read()).toEqual({ mcpServers: { draft: DRAFT_ENTRY(RUN_TWO_URL) } });
  });

  it("is idempotent: the same call twice leaves the same bytes", () => {
    writeDraftMcpConfig(path, RUN_ONE_URL);
    const first = readFileSync(path, "utf8");
    writeDraftMcpConfig(path, RUN_ONE_URL);
    expect(readFileSync(path, "utf8")).toBe(first);
  });

  it("writes the file readable only by its owner and leaves no temporary file", () => {
    writeDraftMcpConfig(path, RUN_ONE_URL);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([".claude.json"]);
  });

  it("refuses a config that is not JSON, and leaves it as it was", () => {
    writeFileSync(path, "{not json");
    expect(() => writeDraftMcpConfig(path, RUN_ONE_URL)).toThrow(`${path} is not valid JSON`);
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });

  it("refuses a config that is not a JSON object", () => {
    writeFileSync(path, "[]");
    expect(() => writeDraftMcpConfig(path, RUN_ONE_URL)).toThrow(`${path} is not a JSON object`);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("[]");
  });

  it("refuses an mcpServers value that is not an object", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: [] }));
    expect(() => writeDraftMcpConfig(path, RUN_ONE_URL)).toThrow("mcpServers value that is not an object");
  });
});

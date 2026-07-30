import { describe, expect, it } from "bun:test";
import { findMcpServer, parseClaudeMcpList, sanitizeMcpMessage, selectConnectedMcpServer } from "../integrations/mcp-health";

const SAMPLE = `claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected
granola: https://mcp.granola.ai/mcp (HTTP) - ✔ Connected
railway: railway mcp - ✘ Failed to connect — -32000: MCP error -32000: Connection closed
fireflies: https://api.fireflies.ai/mcp (HTTP) - ✔ Connected
granola-mcp: npx granola-mcp-server - ✘ Failed to connect — Connection closed`;

describe("Claude MCP health parsing", () => {
  it("parses exact connected and failed server rows", () => {
    expect(parseClaudeMcpList(SAMPLE)).toEqual([
      { id: "claude.ai Google Drive", state: "connected", message: null },
      { id: "granola", state: "connected", message: null },
      { id: "railway", state: "unavailable", message: "-32000: MCP error -32000: Connection closed" },
      { id: "fireflies", state: "connected", message: null },
      { id: "granola-mcp", state: "unavailable", message: "Connection closed" },
    ]);
  });

  it("does not confuse granola with granola-mcp", () => {
    expect(findMcpServer(SAMPLE, "granola")?.state).toBe("connected");
    expect(findMcpServer(SAMPLE, "granola-mcp")?.state).toBe("unavailable");
  });

  it("selects the first connected preferred ID and ignores ANSI escapes", () => {
    const output = `\u001b[32mgranola-mcp: command - ✔ Connected\u001b[0m`;
    expect(selectConnectedMcpServer(output, ["granola", "granola-mcp"])?.id).toBe("granola-mcp");
  });

  it("does not treat a merely registered or failed server as connected", () => {
    expect(selectConnectedMcpServer("granola: command - ✘ Failed to connect — auth failed", ["granola"])).toBeNull();
    expect(findMcpServer("granola-helper: command - ✔ Connected", "granola")).toBeNull();
  });

  it("redacts credentials from persisted failure messages", () => {
    expect(sanitizeMcpMessage("Authorization: Bearer secret token=also-secret")).toBe(
      "Authorization: Bearer [redacted] token=[redacted]",
    );
  });
});

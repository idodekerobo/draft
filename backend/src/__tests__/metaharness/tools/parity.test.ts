import { describe, expect, it } from "bun:test";
import { DRAFT_TOOLS } from "draft-core/tools";
import { PARITY_GAPS, TOOL_COMMANDS } from "draft-core/tool-commands";
import { createDraftToolRegistry } from "../../../metaharness/tools/definitions";
import { fakeClient, fakeDb } from "../../routines/fake-client";

const registry = createDraftToolRegistry(fakeClient(fakeDb()));

describe("the MCP and the CLI offer the same tools", () => {
  it("lists every tool the gateway can serve, and nothing else", () => {
    expect(Object.keys(TOOL_COMMANDS).sort()).toEqual(DRAFT_TOOLS.map((tool) => tool.name).sort());
    expect(registry.list().map((tool) => tool.name).sort()).toEqual(DRAFT_TOOLS.map((tool) => tool.name).sort());
  });

  it.each(DRAFT_TOOLS.map((tool) => tool.name))("%s is in both or in neither, unless it is a listed gap", (name) => {
    const tool = registry.get(name)!;
    const inCli = TOOL_COMMANDS[name] !== null;
    if (tool.mcp === inCli) {
      expect(PARITY_GAPS[name]).toBeUndefined();
    } else {
      expect(typeof PARITY_GAPS[name]).toBe("string");
    }
  });

  it("gives a tool no CLI command and no MCP tool only when no person can call it", () => {
    for (const tool of registry.list()) {
      if (tool.mcp || TOOL_COMMANDS[tool.name as keyof typeof TOOL_COMMANDS] !== null) continue;
      expect(tool.allowedOrigins).not.toContain("person");
    }
  });
});

import { describe, expect, it } from "bun:test";
import {
  parseAgentRunId,
  parseContextVersionId,
  parseHostMachineId,
  parseUserId,
  parseWorkspaceId,
  type AnyDraftToolPermission,
  type ToolCaller,
} from "draft-core/agent-run";
import { invokeTool, type ToolCallRecord } from "../../../metaharness/tools/invoke-tool";
import { MAX_CONFLICTED_WRITES } from "../../../metaharness/tools/definitions/context-tools";
import { sha256 } from "../../../synthesis/context-version-files";
import { createFakeContextDb } from "../context/fake-context-db";
import { createDraftToolRegistry } from "../../../metaharness/tools/definitions";

const WS = "11111111-1111-4111-8111-111111111111";

function setup(files: Record<string, string>, permissions: AnyDraftToolPermission[]) {
  const db = createFakeContextDb(files);
  const caller: ToolCaller = {
    type: "run",
    run: {
      id: parseAgentRunId("22222222-2222-4222-8222-222222222222"),
      kind: "routine",
      workspaceId: parseWorkspaceId(WS),
      trigger: { type: "manual", requestedBy: parseUserId("33333333-3333-4333-8333-333333333333") },
      principal: { type: "workspace" },
      runtime: { type: "local", hostMachineId: parseHostMachineId("mac") },
      harness: "claude",
      model: null,
      instructions: "",
      inputs: { contextVersionId: parseContextVersionId(db.pointer()!) },
      permissions,
      output: { type: "text" },
    },
  };
  const audits: ToolCallRecord[] = [];
  const deps = {
    registry: createDraftToolRegistry(db.client),
    audit: async (record: ToolCallRecord) => {
      audits.push(record);
      if (record.caller.type === "run") db.toolCalls.push({ tool_name: record.toolName, status: record.status, agent_run_id: record.caller.run.id });
    },
  };
  return { db, caller, deps, audits, call: (name: string, args: unknown) => invokeTool(deps, caller, name, args) };
}

describe("context.read", () => {
  it("returns every document with its content and sha when nothing narrows it", async () => {
    const { call, db } = setup({ "a.md": "A", "b.md": "BB" }, [{ tool: "context.read" }]);
    const result = await call("context.read", {});
    expect(result).toMatchObject({ status: "ok", output: { versionId: db.pointer(), versionNumber: 1 } });
    const output = (result as { output: { documents: Array<{ path: string; content: string; sha256: string }> } }).output;
    expect(output.documents).toContainEqual({ path: "b.md", content: "BB", sha256: sha256("BB") });
    expect(output.documents).toHaveLength(2);
  });

  it("returns only the requested paths and names the ones that do not exist", async () => {
    const { call } = setup({ "a.md": "A", "b.md": "B" }, [{ tool: "context.read" }]);
    const result = await call("context.read", { paths: ["a.md", "nope.md"] });
    const output = (result as { output: { documents: Array<{ path: string }>; missing: string[] } }).output;
    expect(output.documents.map((document) => document.path)).toEqual(["a.md"]);
    expect(output.missing).toEqual(["nope.md"]);
  });

  it("narrows by dimension, as the person-facing read always has", async () => {
    const { call } = setup({ "memory/days/2026-11-09.md": "today", "product/index.md": "p" }, [{ tool: "context.read" }]);
    const result = await call("context.read", { dimensions: ["product"] });
    expect((result as { output: { documents: Array<{ path: string }> } }).output.documents.map((d) => d.path)).toEqual(["product/index.md"]);
  });

  it("refuses a bad period request with a code", async () => {
    const { call } = setup({ "a.md": "A" }, [{ tool: "context.read" }]);
    const result = await call("context.read", { period: "today" });
    expect(result).toMatchObject({ status: "refused", code: "invalid_period", message: expect.stringContaining("period requires exactly one dimension") });
  });
});

describe("context.list", () => {
  it("lists each dimension that has an index document", async () => {
    const { call } = setup({ "product/index.md": "p", "team/index.md": "t", "notes/x.md": "x" }, [{ tool: "context.list" }]);
    const result = await call("context.list", {});
    expect(result).toMatchObject({ status: "ok", output: { dimensions: [{ name: "product", path: "product/index.md" }, { name: "team", path: "team/index.md" }] } });
  });
});

describe("tools that need a person", () => {
  it("are not offered to a run, and are refused if it asks", async () => {
    const { call, deps, caller } = setup({ "a.md": "A" }, [{ tool: "sources.search" }, { tool: "sources.read" }, { tool: "context.export" }]);
    if (caller.type !== "run") throw new Error("unreachable");
    expect(deps.registry.listFor(caller.run)).toEqual([]);
    for (const name of ["sources.search", "sources.read", "context.export"]) {
      expect(await call(name, { query: "x", source_item_id: "11111111-1111-4111-8111-111111111111" })).toMatchObject({ status: "denied", code: "caller_not_authorized" });
    }
  });
});

describe("context.write", () => {
  it("writes through the gateway and audits the paths, not the content", async () => {
    const { call, db, audits } = setup({ "a.md": "A" }, [{ tool: "context.write" }]);
    const result = await call("context.write", { summary: "update a", changes: [{ path: "a.md", content: "A2 body" }] });
    expect(result).toMatchObject({ status: "ok", output: { written: ["a.md"] } });
    expect(db.current()["a.md"].content).toBe("A2 body");
    expect(JSON.stringify(audits[0].arguments)).not.toContain("A2 body");
    expect(audits[0].arguments).toMatchObject({ summary: "update a", changes: [{ path: "a.md", bytes: 7 }] });
  });

  it("returns the conflict with current content so the agent can merge", async () => {
    const { call, db } = setup({ "a.md": "A" }, [{ tool: "context.write" }]);
    db.writeBehindTheScenes({ "a.md": "theirs" });
    const result = await call("context.write", { summary: "s", changes: [{ path: "a.md", content: "mine" }] });
    expect(result).toMatchObject({
      status: "conflict",
      output: { retryable: true, retriesLeft: MAX_CONFLICTED_WRITES - 1, conflicts: [{ path: "a.md", currentContent: "theirs", currentSha: sha256("theirs") }] },
    });
  });

  it("reports what landed and what conflicted from one call", async () => {
    const { call, db } = setup({ "a.md": "A", "b.md": "B" }, [{ tool: "context.write" }]);
    db.writeBehindTheScenes({ "b.md": "theirs" });
    const result = await call("context.write", { summary: "s", changes: [{ path: "a.md", content: "A2" }, { path: "b.md", content: "B2" }] });
    expect(result).toMatchObject({
      status: "conflict",
      output: { written: ["a.md"], retryable: true, conflicts: [{ path: "b.md", currentContent: "theirs" }] },
    });
    expect(db.current()["a.md"].content).toBe("A2");
  });

  it("stops taking writes after the conflict cap and tells the agent to report", async () => {
    const { call, db } = setup({ "a.md": "A" }, [{ tool: "context.write" }]);
    db.writeBehindTheScenes({ "a.md": "theirs" });
    for (let i = 0; i < MAX_CONFLICTED_WRITES; i++) {
      await call("context.write", { summary: "s", changes: [{ path: "a.md", content: "mine" }] });
    }
    const rpcBefore = db.rpcCalls.length;
    const result = await call("context.write", { summary: "s", changes: [{ path: "a.md", content: "mine", baseSha: sha256("theirs") }] });
    expect(result).toMatchObject({ status: "conflict", output: { retryable: false } });
    expect(db.rpcCalls.length).toBe(rpcBefore);
    expect(db.current()["a.md"].content).toBe("theirs");
  });

  it("denies paths outside the permission's limits before anything is written", async () => {
    const { call, db } = setup({ "a.md": "A" }, [{ tool: "context.write", limits: { pathPrefixes: ["memory/"] } }]);
    const result = await call("context.write", { summary: "s", changes: [{ path: "a.md", content: "x" }] });
    expect(result).toMatchObject({ status: "denied", code: "outside_limits" });
    expect(db.versionCount()).toBe(1);
  });

  it("rejects a malformed sha as invalid input", async () => {
    const { call } = setup({ "a.md": "A" }, [{ tool: "context.write" }]);
    const result = await call("context.write", { summary: "s", changes: [{ path: "a.md", content: "x", baseSha: "short" }] });
    expect(result.status).toBe("invalid");
  });

  it("is not available to a run that was not given it", async () => {
    const { call, db } = setup({ "a.md": "A" }, [{ tool: "context.read" }]);
    const result = await call("context.write", { summary: "s", changes: [{ path: "a.md", content: "x" }] });
    expect(result).toMatchObject({ status: "denied", code: "not_permitted" });
    expect(db.versionCount()).toBe(1);
  });
});

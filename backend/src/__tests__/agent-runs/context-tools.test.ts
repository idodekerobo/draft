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
import { invokeTool, type ToolCallRecord } from "../../agent-runs/invoke-tool";
import { MAX_CONFLICTED_WRITES } from "../../agent-runs/tools/context-tools";
import { createDraftToolRegistry } from "../../agent-runs/tools";
import { sha256 } from "../../synthesis/context-version-files";
import { createFakeContextDb } from "./fake-context-db";

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
      db.toolCalls.push({ tool_name: record.toolName, status: record.status, agent_run_id: record.run.id });
    },
  };
  return { db, caller, deps, audits, call: (name: string, args: unknown) => invokeTool(deps, caller, name, args) };
}

describe("context.read", () => {
  it("lists documents with their shas when no paths are given", async () => {
    const { call } = setup({ "a.md": "A", "b.md": "BB" }, [{ tool: "context.read" }]);
    const result = await call("context.read", {});
    expect(result).toMatchObject({ status: "ok" });
    const output = (result as { output: { documents: Array<{ path: string; sha: string; bytes: number }> } }).output;
    expect(output.documents).toContainEqual({ path: "b.md", sha: sha256("BB"), bytes: 2 });
  });

  it("returns content for the requested paths and marks missing ones", async () => {
    const { call } = setup({ "a.md": "A" }, [{ tool: "context.read" }]);
    const result = await call("context.read", { paths: ["a.md", "nope.md"] });
    expect((result as { output: { documents: unknown[] } }).output.documents).toEqual([
      { path: "a.md", sha: sha256("A"), content: "A" },
      { path: "nope.md", missing: true },
    ]);
  });
});

describe("context.write", () => {
  it("writes through the gateway and audits the paths, not the content", async () => {
    const { call, db, audits } = setup({ "a.md": "A" }, [{ tool: "context.write" }]);
    const result = await call("context.write", { summary: "update a", changes: [{ path: "a.md", content: "A2 body" }] });
    expect(result).toMatchObject({ status: "ok", output: { changedPaths: ["a.md"] } });
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

describe("request_input", () => {
  it("saves an open question for the run", async () => {
    const { call, db } = setup({ "a.md": "A" }, [{ tool: "request_input" }]);
    const result = await call("request_input", { question: "Which channel?", options: ["#a", "#b"] });
    expect(result).toMatchObject({ status: "ok", output: { status: "open" } });
    expect(db.inputRequests[0]).toMatchObject({ question: "Which channel?", options: ["#a", "#b"], agent_run_id: "22222222-2222-4222-8222-222222222222" });
  });
});

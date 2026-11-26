import { afterEach, describe, expect, it } from "bun:test";
import { registerWorkflows } from "../../routines/register-workflows";
import { clearWorkflows, workflowFor } from "../../routines/workflow/registry";

afterEach(() => clearWorkflows());

describe("registerWorkflows", () => {
  it("tells the engine how synthesis and custom routines carry out their steps", () => {
    expect(() => workflowFor("synthesis")).toThrow("No step workflow is registered for synthesis runs");
    registerWorkflows();
    expect(workflowFor("synthesis").kind).toBe("synthesis");
    expect(workflowFor("routine").kind).toBe("routine");
  });
});

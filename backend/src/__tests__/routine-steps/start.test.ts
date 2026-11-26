import { describe, expect, it } from "bun:test";
import { stepsOfParent } from "../../routine-steps/step-run-spec";
import { startWorkflow } from "../../routine-steps/start";
import { PARENT, children, items, parentRow, setup, step } from "./harness";

const startedParent = { status: "preparing", result_json: null };

describe("starting a routine's run", () => {
  it("saves the steps and extras, marks the run running, and starts the first step's runs", async () => {
    const steps = [step("capture"), step("organize")];
    const h = setup({ steps: [], parent: startedParent, plans: { capture: () => items(2) } });

    expect(await startWorkflow(h.deps, { parentRunId: PARENT, steps, extras: { sourceItemIds: ["s1"] } })).toBe("waiting");

    const parent = parentRow(h);
    expect(parent.status).toBe("running");
    expect(parent.started_at).toBeTruthy();
    expect(parent.result_json).toMatchObject({ sourceItemIds: ["s1"] });
    expect(stepsOfParent(parent as never)?.map((saved) => saved.key)).toEqual(["capture", "organize"]);
    expect(children(h, "capture")).toHaveLength(2);
    expect(h.launched).toHaveLength(2);
  });

  it("works without extras", async () => {
    const h = setup({ steps: [], parent: startedParent });
    await startWorkflow(h.deps, { parentRunId: PARENT, steps: [step("capture")] });
    expect(parentRow(h).result_json).toEqual({ steps: [step("capture")] });
  });
});

import { expect, test } from "bun:test";
import { runResultLine } from "../../../metaharness/runs/result-line";

const call = (tool_name: string, result_summary: string, args: Record<string, unknown> = {}, status = "ok") => ({ agent_run_id: "run", tool_name, result_summary, arguments: args, status });

test("results count delivered actions and unique recipients and documents", () => {
  expect(runResultLine([
    call("slack.post_message", "Posted in #general"),
    call("people.notify", "slack: sent", { personId: "a" }),
    call("people.notify", "slack: sent", { personId: "a" }),
    call("people.notify", "slack: failed", { personId: "b" }),
    call("context.write", "wrote product.md, team.md"),
    call("context.write", "wrote product.md"),
    call("context.write", "no change"),
    call("slack.post_message", "Posted in #private", {}, "refused"),
  ])).toBe("Posted in #general · DM'd 1 person · Updated 2 docs");
});

test("reads and unsuccessful delivery leave room for summary fallback", () => {
  expect(runResultLine([call("sources.read", "read source"), call("people.notify", "slack: failed", { personId: "a" }), call("context.write", "no change")])).toBeNull();
});

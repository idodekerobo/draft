import { expect, test } from "bun:test";
import { runResultLine } from "../../../metaharness/runs/result-line";

const call = (tool_name: string, result_summary: string, args: Record<string, unknown> = {}, status = "ok") => ({ agent_run_id: "run", tool_name, result_summary, arguments: args, status });

test("results count delivered actions and unique recipients and documents", () => {
  expect(runResultLine([
    call("connections.post", "Posted in #general", { provider: "slack" }),
    call("people.notify", "slack: sent", { personId: "a" }),
    call("people.notify", "slack: sent", { personId: "a" }),
    call("people.notify", "slack: failed", { personId: "b" }),
    call("context.write", "wrote product.md, team.md"),
    call("context.write", "wrote product.md"),
    call("context.write", "no change"),
    call("connections.post", "Posted in #private", { provider: "slack" }, "refused"),
  ])).toBe("Posted in #general · DM'd 1 person · Updated 2 docs");
});

test("reads and unsuccessful delivery leave room for summary fallback", () => {
  expect(runResultLine([call("sources.read", "read source"), call("people.notify", "slack: failed", { personId: "a" }), call("context.write", "no change")])).toBeNull();
});

test("includes email sends and deduplicates recipients across repeated calls", () => {
  expect(runResultLine([
    call("people.notify", "email: sent", { personId: "a" }),
    call("people.notify", "slack: sent, email: delivered", { personId: "a" }),
    call("people.notify", "email: queued", { personId: "b" }),
    call("people.notify", "email: bounced", { personId: "c" }),
  ])).toBe("DM'd 1 person · Emailed 1 person");
});

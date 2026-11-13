import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActivityList, type SynthesisRunSummary } from "./ActivityList";

afterEach(cleanup);
const routine: SynthesisRunSummary = {
  id: "run", kind: "routine", sessionId: "session", routineTitle: "Daily standup", status: "succeeded", outcome: null,
  triggerType: "manual", resultSummary: "Posted in #general", startedAt: "2026-11-12T10:00:00Z", completedAt: "2026-11-12T10:01:00Z", createdAt: "2026-11-12T10:00:00Z",
};

test("routine activity opens its transcript and displays the result", () => {
  const open = mock(() => {});
  render(<ActivityList runs={[routine]} onFixInConnections={() => {}} onOpenRun={open} />);
  fireEvent.click(screen.getByText("Daily standup · routine"));
  expect(screen.getByText("Posted in #general")).toBeTruthy();
  fireEvent.click(screen.getByText("Open run"));
  expect(open).toHaveBeenCalledWith("session");
});

test("completed runs without duration do not claim to still be running", () => {
  render(<ActivityList runs={[{ ...routine, kind: "summarization", startedAt: null }]} onFixInConnections={() => {}} />);
  fireEvent.click(screen.getByText("Summarization"));
  expect(screen.getByText("Unavailable")).toBeTruthy();
  expect(screen.queryByText("Open run")).toBeNull();
});

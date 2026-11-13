import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TeamStrip } from "./TeamStrip";
import type { TeamMember } from "./team-roster";

afterEach(cleanup);

const member = (name: string, state: TeamMember["state"], hostSeq: number): TeamMember => ({ name, state, hostSeq, description: `Does ${name}`, model: "haiku" });

describe("TeamStrip", () => {
  it("shows nothing without agents", () => {
    const { container } = render(<TeamStrip members={[]} onShow={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a chip per agent with its state in words, and jumps to its work on click", () => {
    const onShow = mock();
    const members = [member("test-updater", "idle", 4), member("cli-routines", "working", 9)];
    render(<TeamStrip members={members} onShow={onShow} />);
    const chips = screen.getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["@test-updateridle", "@cli-routinesworking"]);
    expect(chips[1]!.querySelector(".ui-dot--pending")).not.toBeNull();
    expect(chips[0]!.querySelector(".ui-dot--pending")).toBeNull();
    fireEvent.click(chips[1]!);
    expect(onShow).toHaveBeenCalledWith(members[1]);
  });
});

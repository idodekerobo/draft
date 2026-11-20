import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AbilityFields, accessLines, defaultCapabilities, type CapabilityValue } from "./CapabilityFields";

afterEach(cleanup);

function setup(value: CapabilityValue, harness = "claude") {
  const onChange = mock((_value: CapabilityValue) => {});
  render(<AbilityFields harness={harness} value={value} onChange={onChange} disabled={false} fieldError={() => null} connectedProviders={[]} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit access" }));
  return onChange;
}

describe("routine built-in tools", () => {
  it("starts a new Claude Code routine with every built-in tool", () => {
    expect(defaultCapabilities([], "claude").builtInTools).toEqual(["Edit", "Write", "Bash", "WebSearch", "WebFetch"]);
    expect(defaultCapabilities([], "codex").builtInTools).toEqual(["web_search"]);
  });

  it("turns all of them off or on with one box, and shows a mixed box for some", () => {
    const onChange = setup({ ...defaultCapabilities([], "claude") });
    const all = screen.getByRole("checkbox", { name: "Enable Claude Code built-in tools" }) as HTMLInputElement;
    expect(all.checked).toBe(true);
    fireEvent.click(all);
    expect(onChange.mock.calls.at(-1)![0].builtInTools).toEqual([]);
    cleanup();
    setup({ ...defaultCapabilities([], "claude"), builtInTools: ["Edit"] });
    expect((screen.getByRole("checkbox", { name: "Enable Claude Code built-in tools" }) as HTMLInputElement).indeterminate).toBe(true);
  });

  it("picks one tool at a time, in plain words with the tool's name", () => {
    const onChange = setup({ ...defaultCapabilities([], "claude"), builtInTools: ["Edit"] });
    fireEvent.click(screen.getByRole("checkbox", { name: /Run shell commands/ }));
    expect(onChange.mock.calls.at(-1)![0].builtInTools).toEqual(["Edit", "Bash"]);
    expect(screen.getByText("Reading files is always on.")).toBeTruthy();
  });

  it("names Codex's own tools for a Codex routine", () => {
    setup({ ...defaultCapabilities([], "codex") }, "codex");
    expect(screen.getByRole("checkbox", { name: "Enable Codex built-in tools" })).toBeTruthy();
    expect(screen.getByText("Codex always runs shell commands and edits files.")).toBeTruthy();
  });

  it("says in the preview what the routine can do", () => {
    expect(accessLines({ ...defaultCapabilities([], "claude"), builtInTools: ["Edit", "WebFetch"] })).toContain("Can edit files, fetch web pages");
  });
});

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LabPicker } from "./LabPicker";

afterEach(cleanup);

const labs = [
  { id: "anthropic", label: "Anthropic", enabled: true },
  { id: "openai", label: "OpenAI", enabled: false },
];

describe("LabPicker", () => {
  it("shows the current lab and lets an admin choose an available one", () => {
    const onChange = mock(() => {});
    render(<LabPicker labs={labs} value="anthropic" canEdit onChange={onChange} />);
    expect((screen.getByLabelText("Anthropic") as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("An admin chooses this for your workspace.")).toBeNull();
  });

  it("reports the lab an admin picks", () => {
    const onChange = mock(() => {});
    const both = labs.map((lab) => ({ ...lab, enabled: true }));
    render(<LabPicker labs={both} value="anthropic" canEdit onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("OpenAI"));
    expect(onChange).toHaveBeenCalledWith("openai");
  });

  it("shows a lab that is not available yet as later, and cannot select it", () => {
    const onChange = mock(() => {});
    render(<LabPicker labs={labs} value="anthropic" canEdit onChange={onChange} />);
    expect(screen.getByText("Coming later")).toBeTruthy();
    expect((screen.getByLabelText(/OpenAI/) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/OpenAI/));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is read-only for a member, with a line that says why", () => {
    render(<LabPicker labs={labs} value="anthropic" canEdit={false} onChange={() => {}} />);
    expect(screen.getByText("An admin chooses this for your workspace.")).toBeTruthy();
    expect(screen.getByRole("group").hasAttribute("disabled")).toBe(true);
  });

  it("shows a save error", () => {
    render(<LabPicker labs={labs} value="anthropic" canEdit error="Could not save" onChange={() => {}} />);
    expect(screen.getByRole("alert").textContent).toBe("Could not save");
  });
});

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Select } from "./Select";

afterEach(cleanup);

const zones = ["UTC", "America/Chicago", "America/New_York", "Europe/London"].map((zone) => ({ value: zone, label: zone }));

describe("Select", () => {
  it("shows the chosen option and picks another from its list", () => {
    const onChange = mock((_value: string) => {});
    render(<Select label="Timezone" value="UTC" options={zones} onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Timezone" });
    expect(trigger.textContent).toContain("UTC");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Europe\/London/ }));
    expect(onChange).toHaveBeenCalledWith("Europe/London");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("narrows a long list as the person types", () => {
    render(<Select label="Timezone" value="UTC" options={zones} onChange={() => {}} searchable />);
    fireEvent.click(screen.getByRole("button", { name: "Timezone" }));
    fireEvent.change(screen.getByLabelText("Search Timezone"), { target: { value: "america" } });
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent?.replace("✓", ""))).toEqual(["America/Chicago", "America/New_York"]);
    fireEvent.change(screen.getByLabelText("Search Timezone"), { target: { value: "mars" } });
    expect(screen.getByText("No matches")).toBeTruthy();
  });

  it("does not open while disabled", () => {
    render(<Select label="Day" value="mon" options={[{ value: "mon", label: "Monday" }]} onChange={() => {}} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

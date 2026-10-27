import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SectionedPicker, type PickerSection } from "./SectionedPicker";

afterEach(cleanup);

function setup() {
  const onModel = mock((_value: string) => {});
  const sections: PickerSection[] = [
    { id: "harness", title: "Harnesses", value: "claude", onChange: () => {}, options: [{ value: "claude", label: "Claude Code" }] },
    { id: "model", title: "Models", value: "", onChange: onModel, options: [{ value: "", label: "Default" }, { value: "opus", label: "Opus", hint: "slow" }] },
  ];
  render(<SectionedPicker label="Agent and model" sections={sections}>Default</SectionedPicker>);
  return { onModel };
}

describe("SectionedPicker", () => {
  it("shows its button label and keeps the panel closed", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Agent and model" });
    expect(trigger.textContent).toContain("Default");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens with every section titled and the selected options checked", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Agent and model" }));
    expect(screen.getByRole("group", { name: "Harnesses" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Models" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /Claude Code/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Default/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: /Opus/ }).getAttribute("aria-checked")).toBe("false");
  });

  it("reports the choice, closes, and returns focus to the button", () => {
    const { onModel } = setup();
    const trigger = screen.getByRole("button", { name: "Agent and model" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Opus/ }));
    expect(onModel).toHaveBeenCalledWith("opus");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape and moves between options with the arrow keys", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Agent and model" });
    fireEvent.click(trigger);
    const items = screen.getAllByRole("menuitemradio");
    items[0]!.focus();
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

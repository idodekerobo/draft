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

  it("puts a row section above the other lists and keeps the panel open for a keepOpen choice", () => {
    const onHarness = mock((_value: string) => {});
    const sections: PickerSection[] = [
      { id: "harness", title: "Harnesses", row: true, keepOpen: true, value: "claude", onChange: onHarness, options: [{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }] },
      { id: "model", title: "Models", value: "", onChange: () => {}, options: [{ value: "", label: "Default" }] },
    ];
    render(<SectionedPicker label="Agent" sections={sections}>x</SectionedPicker>);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    const panel = screen.getByRole("menu");
    expect(panel.className).toContain("ui-picker__panel--stacked");
    expect(panel.firstElementChild?.className).toContain("ui-picker__section--row");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Codex/ }));
    expect(onHarness).toHaveBeenCalledWith("codex");
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("leaves focus on the button after a mouse click, and moves it into the panel after a keyboard open", () => {
    setup();
    const trigger = screen.getByRole("button", { name: "Agent and model" });
    fireEvent.click(trigger, { detail: 1 });
    expect(document.activeElement).not.toBe(screen.getByRole("menuitemradio", { name: /Default/ }));
    expect(screen.getAllByRole("menuitemradio").some((item) => item === document.activeElement)).toBe(false);
    fireEvent.click(trigger, { detail: 1 });
    fireEvent.click(trigger, { detail: 0 });
    expect(screen.getAllByRole("menuitemradio").some((item) => item === document.activeElement)).toBe(true);
  });

  it("marks where the panel lines up and which way it opens", () => {
    render(<SectionedPicker label="Agent" sections={[{ id: "m", title: "Models", value: "", onChange: () => {}, options: [{ value: "", label: "Default" }] }]} align="start" direction="up">x</SectionedPicker>);
    const root = screen.getByRole("button", { name: "Agent" }).parentElement!;
    expect(root.className).toContain("ui-picker--align-start");
    expect(root.className).toContain("ui-picker--up");
  });
});

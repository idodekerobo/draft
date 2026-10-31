import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BackButton } from "./BackButton";

afterEach(cleanup);

describe("BackButton", () => {
  it("is named Back, shows no page name, and calls onClick", () => {
    const onClick = mock(() => {});
    render(<BackButton onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Back" });
    expect(button.textContent).toBe("");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("takes a more exact name when a screen needs one", () => {
    render(<BackButton onClick={() => {}} label="Back to routine" />);
    expect(screen.getByRole("button", { name: "Back to routine" })).toBeTruthy();
  });
});

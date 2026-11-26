import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ModelProviderPicker, type ModelProviderView } from "./ModelProviderPicker";

afterEach(cleanup);

const view = (overrides: Partial<ModelProviderView> = {}): ModelProviderView => ({
  provider: "anthropic",
  canEdit: true,
  providers: [{ id: "anthropic", label: "Anthropic", enabled: true }, { id: "openai", label: "OpenAI", enabled: true }],
  ...overrides,
});

describe("ModelProviderPicker", () => {
  it("shows nothing until the workspace's lab is known", () => {
    const { container } = render(<ModelProviderPicker load={() => new Promise(() => {})} save={async () => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("saves the lab an admin picks", async () => {
    const save = mock(async () => {});
    render(<ModelProviderPicker load={async () => view()} save={save} />);
    fireEvent.click(await screen.findByLabelText("OpenAI"));
    await waitFor(() => expect(save).toHaveBeenCalledWith("openai"));
    expect((screen.getByLabelText("OpenAI") as HTMLInputElement).checked).toBe(true);
  });

  it("goes back to the earlier lab and says so when the save fails", async () => {
    render(<ModelProviderPicker load={async () => view()} save={async () => { throw new Error("down"); }} />);
    fireEvent.click(await screen.findByLabelText("OpenAI"));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not save your choice. Try again.");
    expect((screen.getByLabelText("Anthropic") as HTMLInputElement).checked).toBe(true);
  });
});

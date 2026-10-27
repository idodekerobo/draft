import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InviteLinkRow, type InviteLink } from "./InviteLinkRow";

afterEach(cleanup);

const LINK: InviteLink = { url: "https://app.example.test/invite/abc", expiresAt: "2026-12-01T12:00:00Z" };

describe("InviteLinkRow", () => {
  it("shows the active link with a copy button, and creates nothing", async () => {
    const load = mock(async (_create: boolean) => LINK);
    render(<InviteLinkRow loadInvite={load} />);
    await screen.findByText("https://app.example.test/invite/abc");
    expect(screen.getByRole("button", { name: /Copy https/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create invite link" })).toBeNull();
    expect(load.mock.calls).toEqual([[false]]);
  });

  it("offers to create a link when none is active, then shows it", async () => {
    const load = mock(async (create: boolean) => (create ? LINK : { url: null, expiresAt: null }));
    render(<InviteLinkRow loadInvite={load} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create invite link" }));
    await screen.findByText("https://app.example.test/invite/abc");
    expect(load.mock.calls).toEqual([[false], [true]]);
  });

  it("shows an error and retries a look-up, not a create", async () => {
    let fail = true;
    const load = mock(async (_create: boolean) => {
      if (fail) throw new Error("down");
      return LINK;
    });
    render(<InviteLinkRow loadInvite={load} />);
    await screen.findByText("Could not load the invite link.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("https://app.example.test/invite/abc");
    expect(load.mock.calls).toEqual([[false], [false]]);
  });

  it("copies the link to the clipboard", async () => {
    const writeText = mock(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<InviteLinkRow loadInvite={async () => LINK} />);
    fireEvent.click(await screen.findByRole("button", { name: /Copy https/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://app.example.test/invite/abc"));
  });
});

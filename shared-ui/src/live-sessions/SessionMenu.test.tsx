import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SessionsLayout } from "./SessionsLayout";
import type { LiveSession } from "./types";

afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

const make = (id: string, over: Partial<LiveSession> = {}): LiveSession => ({
  id, owner_user_id: "u", owner_name: "Maya", title: `title ${id}`, folder_name: "app", host_name: null, status: "ended",
  started_at: new Date().toISOString(), ended_at: null, last_event_at: null, last_seq: 0, mine: true, session_type: "interactive", ...over,
});

function setup(sessions: LiveSession[], deleteSession = mock(async (_id: string) => {}), extra: Partial<Parameters<typeof SessionsLayout>[0]> = {}) {
  const onDeleted = mock((_id: string) => {});
  render(
    <SessionsLayout sessions={sessions} selectedId={null} onSelect={() => {}} api={{ deleteSession }} onDeleted={onDeleted} {...extra}>
      <p>main</p>
    </SessionsLayout>,
  );
  return { deleteSession, onDeleted };
}

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "Session options" }));

describe("deleting from the session list", () => {
  it("asks first, then deletes and reports it", async () => {
    const { deleteSession, onDeleted } = setup([make("a")]);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(deleteSession).not.toHaveBeenCalled();
    const dialog = screen.getByText(/Nobody on your team will be able to see it/);
    expect(dialog.textContent).toContain("Files on your computer are not removed");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith("a"));
    expect(deleteSession).toHaveBeenCalledWith("a");
    expect(screen.queryByText(/Nobody on your team will be able to see it/)).toBeNull();
  });

  it("says a live session ends first", () => {
    setup([make("a", { status: "live" })]);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByText(/It ends first/)).toBeTruthy();
  });

  it("deletes nothing when cancelled", () => {
    const { deleteSession } = setup([make("a")]);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(deleteSession).not.toHaveBeenCalled();
    expect(screen.queryByText(/Nobody on your team will be able to see it/)).toBeNull();
  });

  it("keeps the dialog open and shows an error when the delete fails", async () => {
    const { onDeleted } = setup([make("a")], mock(async () => { throw new Error("boom"); }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("offers no menu on someone else's session, a routine run, or when the app cannot delete", () => {
    setup([make("a", { mine: false }), make("b", { session_type: "routine" })]);
    expect(screen.queryByRole("button", { name: "Session options" })).toBeNull();
    cleanup();
    render(<SessionsLayout sessions={[make("c")]} selectedId={null} onSelect={() => {}}><p>main</p></SessionsLayout>);
    expect(screen.queryByRole("button", { name: "Session options" })).toBeNull();
  });

  it("shows the app's own items above Delete", () => {
    setup([make("a")], undefined, { menuItems: () => [{ label: "Reveal in Finder", onSelect: () => {} }] });
    openMenu();
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Reveal in Finder", "Delete"]);
  });
});

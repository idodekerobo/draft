import { afterEach, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Disclosure, DisclosureState, SessionViewStateProvider, SessionViewStates, useSessionViewStates } from "./view-state";

afterEach(cleanup);

it("evicts the least recently used session at twenty and keeps the recently read one", () => {
  const states = new SessionViewStates();
  states.get("a").scroll = 120;
  states.get("b").expanded = { 1: true };
  for (let i = 0; i < 18; i++) states.get(`s${i}`);
  states.get("a");
  states.get("new");
  expect(states.get("a").scroll).toBe(120);
  expect(states.get("b").expanded).toEqual({});
});

it("clears state on viewer change and removes every viewer's state for a deleted session", () => {
  const states = new SessionViewStates();
  states.setViewer("a");
  states.get("a:s1").scroll = 120;
  states.setViewer("b");
  expect(states.get("a:s1").scroll).toBeNull();
  states.get("b:s1").expanded = { 1: true };
  states.deleteSession("s1");
  expect(states.get("b:s1").expanded).toEqual({});
});

function Example({ id }: { id: string }) {
  const states = useSessionViewStates();
  const [expanded, setExpanded] = useState(states.get(id).expanded);
  return <DisclosureState.Provider value={{ expanded, change(seq, open) {
    const next = { ...expanded, [seq]: open };
    states.get(id).expanded = next;
    setExpanded(next);
  } }}>
    <Disclosure seq={1} summary="Parent">{() => <Disclosure seq={2} summary="Nested">{() => <p>Nested body</p>}</Disclosure>}</Disclosure>
  </DisclosureState.Provider>;
}

function toggle(details: HTMLDetailsElement, open: boolean) {
  details.open = open;
  fireEvent(details, new Event("toggle"));
}

it("restores nested expansion after closing a parent and switching sessions, and clears it on scope change", () => {
  const tree = (id: string, scope = "user:workspace") => <SessionViewStateProvider scope={scope}><Example key={id} id={id} /></SessionViewStateProvider>;
  const { container, rerender } = render(tree("a"));
  toggle(container.querySelector("details")!, true);
  toggle(container.querySelectorAll("details")[1]!, true);
  expect(screen.getByText("Nested body")).toBeTruthy();
  toggle(container.querySelector("details")!, false);
  expect(screen.queryByText("Nested body")).toBeNull();
  toggle(container.querySelector("details")!, true);
  expect(screen.getByText("Nested body")).toBeTruthy();
  rerender(tree("b"));
  expect(screen.queryByText("Nested body")).toBeNull();
  rerender(tree("a"));
  expect(screen.getByText("Nested body")).toBeTruthy();
  rerender(tree("a", "other-workspace"));
  expect(screen.queryByText("Nested body")).toBeNull();
});

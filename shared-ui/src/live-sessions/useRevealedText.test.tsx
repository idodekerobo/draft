import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { useRevealedText } from "./useRevealedText";

afterEach(cleanup);

function frameClock() {
  const callbacks = new Map<number, (time: number) => void>();
  let nextId = 0;
  let now = 0;
  return {
    requestFrame: (cb: (time: number) => void) => {
      callbacks.set(++nextId, cb);
      return nextId;
    },
    cancelFrame: (handle: number) => void callbacks.delete(handle),
    pending: () => callbacks.size,
    frame: (ms: number) => {
      now += ms;
      const due = [...callbacks.values()];
      callbacks.clear();
      act(() => due.forEach((cb) => cb(now)));
    },
  };
}

function setup(initial: string, deps: Parameters<typeof useRevealedText>[1] = {}) {
  function Probe({ text }: { text: string }) {
    return <p>{useRevealedText(text, deps)}</p>;
  }
  const view = render(<Probe text={initial} />);
  return {
    shown: () => view.container.textContent,
    rerender: (text: string) => view.rerender(<Probe text={text} />),
    unmount: () => view.unmount(),
  };
}

describe("useRevealedText", () => {
  it("shows text present at mount whole", () => {
    const clock = frameClock();
    const t = setup("Hello there", clock);
    expect(t.shown()).toBe("Hello there");
    expect(clock.pending()).toBe(0);
  });

  it("reveals appended text over several frames and ends with the full text", () => {
    const clock = frameClock();
    const full = "Hi there, world";
    const t = setup("Hi", clock);
    t.rerender(full);
    expect(t.shown()).toBe("Hi");
    let frames = 0;
    while (clock.pending() > 0 && frames < 500) {
      clock.frame(16);
      frames++;
    }
    expect(frames).toBeGreaterThan(1);
    expect(t.shown()).toBe(full);
  });

  it("shows the full text at once with reduced motion", () => {
    const clock = frameClock();
    const t = setup("Hi", { ...clock, reducedMotion: () => true });
    t.rerender("Hi there, world");
    expect(t.shown()).toBe("Hi there, world");
    expect(clock.pending()).toBe(0);
  });

  it("shows a replacement text whole at once", () => {
    const clock = frameClock();
    const t = setup("Hi", clock);
    t.rerender("Hi there");
    t.rerender("Bye");
    expect(t.shown()).toBe("Bye");
    expect(clock.pending()).toBe(0);
  });

  it("cancels the pending frame on unmount", () => {
    const clock = frameClock();
    const t = setup("Hi", clock);
    t.rerender("Hi there, world");
    expect(clock.pending()).toBe(1);
    t.unmount();
    expect(clock.pending()).toBe(0);
  });
});

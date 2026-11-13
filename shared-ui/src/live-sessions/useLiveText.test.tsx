import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { LiveTextChunk } from "draft-core/live-sessions";
import { useLiveText } from "./useLiveText";
import type { LiveSessionEvent, LiveSessionsApi } from "./types";

afterEach(cleanup);

const stored = (seq: number, text: string): LiveSessionEvent => ({ seq, source_id: `s${seq}`, kind: "assistant_text", payload: { text }, created_at: "" });

function setup(initial: LiveSessionEvent[]) {
  let emit: (chunk: LiveTextChunk) => void = () => {};
  let stopped = 0;
  const api = {
    watchLiveText: (_sessionId: string, onChunk: (chunk: LiveTextChunk) => void) => {
      emit = onChunk;
      return () => void stopped++;
    },
  } as unknown as LiveSessionsApi;
  function Probe({ events }: { events: LiveSessionEvent[] }) {
    const previews = useLiveText(api, "s1", events);
    return <ul>{previews.map((p) => <li key={p.messageId}>{p.text}</li>)}</ul>;
  }
  const view = render(<Probe events={initial} />);
  return {
    send: (chunk: LiveTextChunk) => act(() => emit(chunk)),
    rerender: (events: LiveSessionEvent[]) => view.rerender(<Probe events={events} />),
    unmount: () => view.unmount(),
    stopped: () => stopped,
  };
}

describe("useLiveText", () => {
  it("shows the text of each chunk as it arrives", () => {
    const t = setup([stored(1, "Earlier")]);
    t.send({ messageId: "m1", index: 0, text: "Hel", final: false });
    t.send({ messageId: "m1", index: 1, text: "lo", final: false });
    expect(screen.getByText("Hello")).toBeTruthy();
  });

  it("removes the preview when the stored message with the same text arrives", () => {
    const t = setup([stored(1, "Earlier")]);
    t.send({ messageId: "m1", index: 0, text: "Hello", final: true });
    t.rerender([stored(1, "Earlier"), stored(2, "Hello")]);
    expect(screen.queryByText("Hello")).toBeNull();
  });

  it("stops the subscription when unmounted", () => {
    const t = setup([]);
    t.unmount();
    expect(t.stopped()).toBe(1);
  });
});

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { connectionState, useConnectionState } from "./useConnectionState";
import type { LiveSessionsApi } from "./types";

afterEach(cleanup);
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("connectionState", () => {
  it("says nothing while connected, while the drop is short, and where signals do not exist", () => {
    expect(connectionState({ watched: true, connected: true, slow: false, online: true })).toBe("live");
    expect(connectionState({ watched: true, connected: false, slow: false, online: true })).toBe("live");
    expect(connectionState({ watched: false, connected: false, slow: true, online: false })).toBe("live");
  });

  it("says reconnecting after a long drop, and offline at once when the browser is offline", () => {
    expect(connectionState({ watched: true, connected: false, slow: true, online: true })).toBe("reconnecting");
    expect(connectionState({ watched: true, connected: false, slow: false, online: false })).toBe("offline");
  });
});

describe("useConnectionState", () => {
  function setup() {
    let report: (connected: boolean) => void = () => {};
    const api = { watchConnection: (onChange: (connected: boolean) => void) => ((report = onChange), () => {}) } as unknown as LiveSessionsApi;
    function Probe() {
      return <span data-testid="state">{useConnectionState(api, 30)}</span>;
    }
    render(<Probe />);
    return (connected: boolean) => act(() => report(connected));
  }

  it("waits before it says reconnecting, and clears the moment the connection is back", async () => {
    const report = setup();
    expect(screen.getByTestId("state").textContent).toBe("live");
    report(false);
    await act(() => wait(10));
    expect(screen.getByTestId("state").textContent).toBe("live");
    await act(() => wait(50));
    expect(screen.getByTestId("state").textContent).toBe("reconnecting");
    report(true);
    expect(screen.getByTestId("state").textContent).toBe("live");
  });

  it("ignores a drop that mends before the wait is over", async () => {
    const report = setup();
    report(false);
    await act(() => wait(10));
    report(true);
    await act(() => wait(50));
    expect(screen.getByTestId("state").textContent).toBe("live");
  });
});

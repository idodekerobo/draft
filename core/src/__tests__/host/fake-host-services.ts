import type { HostServices } from "../../host/services";

const unexpected = (name: string) => (): never => {
  throw new Error(`unexpected host service call: ${name}`);
};

/** Host services for tests. A method the test does not supply throws, so an unexpected call fails the test. */
export function fakeHostServices(overrides: Partial<HostServices> = {}): HostServices {
  return {
    fetchServer: unexpected("fetchServer"),
    fetchServerJSON: unexpected("fetchServerJSON"),
    realtime: { connected: unexpected("realtime.connected"), watch: unexpected("realtime.watch"), send: unexpected("realtime.send") },
    capture: unexpected("capture"),
    openInTerminal: unexpected("openInTerminal"),
    workspaceId: unexpected("workspaceId"),
    hostId: unexpected("hostId"),
    ...overrides,
  };
}

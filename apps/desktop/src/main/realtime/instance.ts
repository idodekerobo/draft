import { connectSignals } from "./connect-signals";
import { RealtimeManager } from "./realtime-manager";

let sendToWindow: (topic: string, event: string) => void = () => {};

/** The one manager of the app. The host and the window both watch topics through it. */
export const realtime = new RealtimeManager(connectSignals, (topic, event) => sendToWindow(topic, event));

export function setSignalSender(send: (topic: string, event: string) => void): void {
  sendToWindow = send;
}

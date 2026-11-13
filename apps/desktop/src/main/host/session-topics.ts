import { liveTextTopic, sessionSignalTopic } from "draft-core/live-sessions";

type Watch = (topic: string, listener: (event: string) => void) => () => void;

/**
 * The realtime topics a session host holds. It joins them only after the server has accepted a request for the
 * session. A join to a session this login cannot read is answered slowly, and it holds up every other join
 * on the connection.
 */
export class SessionTopics {
  private stops: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly watch: Watch,
    private readonly sessionId: string,
    private readonly onSignal: (event: string) => void,
  ) {}

  /** The server knows this session and this login may use it. */
  open(): void {
    if (this.closed || this.stops.length > 0) return;
    this.stops = [this.watch(sessionSignalTopic(this.sessionId), this.onSignal), this.watch(liveTextTopic(this.sessionId), () => {})];
  }

  close(): void {
    this.closed = true;
    for (const stop of this.stops) stop();
    this.stops = [];
  }
}

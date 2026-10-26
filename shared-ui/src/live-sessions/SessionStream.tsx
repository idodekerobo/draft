import type { LiveSessionEvent } from "./types";

export function SessionStream({ events }: { events: LiveSessionEvent[] }) {
  if (events.length === 0) return <p className="ui-muted" role="status">Waiting for the first message…</p>;
  return (
    <ol className="ui-session-stream">
      {events.map((event) => (
        <li key={event.seq} className={`ui-session-stream__item ui-session-stream__item--${event.kind}`}>
          <span className="ui-session-stream__who">{event.kind === "user_message" ? "You" : "Claude"}</span>
          <p className="ui-session-stream__text">{event.payload.text}</p>
        </li>
      ))}
    </ol>
  );
}

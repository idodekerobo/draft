import { useEffect, useState } from "react";
import { cloudStartNotice, elapsedLabel } from "./cloud-start-notice";
import type { LiveSession } from "./types";

/** A one-second clock, only while a machine is starting, for the elapsed time. */
function useSecondClock(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** Shows that a cloud session's machine is starting or waking, or why it never started. */
export function CloudStartNoticeView({ session }: { session: LiveSession }) {
  const notice = cloudStartNotice(session);
  const now = useSecondClock(notice?.tone === "progress");
  if (!notice) return null;
  const error = notice.tone === "error";
  return (
    <div className={`ui-session__start ui-session__start--${notice.tone}`} role={error ? "alert" : "status"}>
        <p className="ui-session__start-title">
          {notice.title}
          {!error && <span className="ui-muted ui-session__start-clock"> {elapsedLabel(session.started_at, now)}</span>}
        </p>
        <p className="ui-muted">{notice.detail}</p>
    </div>
  );
}

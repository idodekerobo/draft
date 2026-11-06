"use client";

import type { DownloadSurface } from "draft-shared-ui";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import { DOWNLOAD_URL } from "@/lib/config";

// The sessions step and Settings have their own download controls.
type NudgeSurface = Exclude<DownloadSurface, "agents_step" | "settings">;

const COPY: Record<NudgeSurface, { title: string; body: string }> = {
  sources_step: {
    title: "More sources on desktop",
    body: "Read a folder of docs and connect Slack.",
  },
  reading_step: {
    title: "Get the desktop app",
    body: "Import docs, connect Slack and run team coding sessions.",
  },
  download_page: {
    title: "Get the desktop app",
    body: "Import docs, connect Slack and run team coding sessions.",
  },
};

export function DesktopNudge({ surface, signedIn = true }: { surface: NudgeSurface; signedIn?: boolean }) {
  const { track } = useAnalytics();
  const { title, body } = COPY[surface];

  function onClick() {
    track("desktop_download_clicked", { surface });
    if (signedIn && (surface === "reading_step" || surface === "download_page")) track("onboarding_finish_chosen", { choice: "desktop" });
  }

  return (
    <section className="desktop-nudge" aria-label={title}>
      <h2 className="ui-group-label">{title}</h2>
      <p className="ui-flow__subtitle">{body}</p>
      <a className="ui-btn" href={DOWNLOAD_URL} onClick={onClick}>Download for Mac</a>
      <p className="ui-flow__note">Apple Silicon Macs (M1 or later) only.</p>
    </section>
  );
}

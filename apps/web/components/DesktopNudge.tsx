"use client";

import type { DownloadSurface } from "draft-shared-ui";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import { DOWNLOAD_URL } from "@/lib/config";

type NudgeSurface = Exclude<DownloadSurface, "settings">;

const COPY: Record<NudgeSurface, { title: string; body: string }> = {
  agents_step: {
    title: "Sessions need the desktop app",
    body: "Claude Code and Codex run on your computer, so starting a session takes the Draft desktop app. It detects the tools you have installed and gets them ready in one click. You can do this any time.",
  },
  sources_step: {
    title: "Want more sources?",
    body: "The desktop app can read a folder of docs on your computer and connect Slack. It also shares your coding sessions with your team.",
  },
  reading_step: {
    title: "Add more while Draft reads",
    body: "Get the desktop app to import a folder of docs, connect Slack and share your coding sessions with your team.",
  },
  download_page: {
    title: "Get the desktop app",
    body: "Import a folder of docs, connect Slack and share your coding sessions with your team.",
  },
};

export function DesktopNudge({ surface }: { surface: NudgeSurface }) {
  const { track } = useAnalytics();
  const { title, body } = COPY[surface];

  function onClick() {
    track("desktop_download_clicked", { surface });
    if (surface === "reading_step" || surface === "download_page") track("onboarding_finish_chosen", { choice: "desktop" });
  }

  return (
    <section aria-label={title}>
      <h2 className="ui-group-label">{title}</h2>
      <p className="ui-flow__subtitle">{body}</p>
      <a className="ui-btn" href={DOWNLOAD_URL} onClick={onClick}>Download for Mac</a>
      <p className="ui-flow__note">Apple Silicon Macs only (M1 or later). Intel Macs and Windows are not supported yet.</p>
    </section>
  );
}

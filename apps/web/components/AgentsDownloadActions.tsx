"use client";

import { FlowActions } from "draft-shared-ui";
import { useAnalytics } from "@/lib/analytics/AnalyticsProvider";
import { DOWNLOAD_URL } from "@/lib/config";

/** The web version of the sessions step ends in the download, and a quiet way past it. */
export function AgentsDownloadActions({ onContinue }: { onContinue: () => void }) {
  const { track } = useAnalytics();
  return (
    <FlowActions
      primary={
        <a
          className="ui-btn ui-btn--primary ui-btn--large"
          href={DOWNLOAD_URL}
          onClick={() => track("desktop_download_clicked", { surface: "agents_step" })}
        >
          Download for Mac
        </a>
      }
      secondary={<button type="button" className="ui-link" onClick={onContinue}>Maybe later</button>}
      note="Apple Silicon Macs (M1 or later) only."
    />
  );
}

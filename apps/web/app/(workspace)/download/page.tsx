import { FlowShell } from "draft-shared-ui";
import { DesktopNudge } from "@/components/DesktopNudge";

export default function DownloadPage() {
  return (
    <FlowShell>
      <h1>Draft for desktop</h1>
      <DesktopNudge surface="download_page" />
      <hr className="ui-flow__divider" />
      <a className="ui-link" href="/">Continue on web</a>
    </FlowShell>
  );
}

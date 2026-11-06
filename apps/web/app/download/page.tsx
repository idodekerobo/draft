import { FlowShell } from "draft-shared-ui";
import { DesktopNudge } from "@/components/DesktopNudge";
import { getServerIdentity } from "@/lib/server-identity";
import { parseSignupSource } from "@/lib/signup-source";

// Public: marketing pages link here, and people on a phone need the web option before they sign up.
export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<{ src?: string }>;
}) {
  const { src } = await searchParams;
  // Keep the campaign tag through signup. Every other source becomes "join", which skips this page.
  const source = parseSignupSource(src) === "multiplayer-coding" ? "multiplayer-coding" : "join";
  const identity = await getServerIdentity();
  const signedIn = identity.state === "ok";

  return (
    <FlowShell>
      <h1>Draft for desktop</h1>
      <DesktopNudge surface="download_page" signedIn={signedIn} />
      <hr className="ui-flow__divider" />
      <a className="ui-link" href={signedIn ? "/" : `/signup?src=${source}`}>Continue on web</a>
    </FlowShell>
  );
}
